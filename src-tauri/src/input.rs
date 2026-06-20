use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSnapshot {
    pub app_name: String,
    pub text: String,
    pub focused: bool,
}

pub fn current_snapshot() -> InputSnapshot {
    platform_snapshot()
}

#[cfg(target_os = "macos")]
fn platform_snapshot() -> InputSnapshot {
    macos::current_snapshot()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::InputSnapshot;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        ptr,
    };

    type Boolean = u8;
    type CFIndex = isize;
    type CFArrayRef = *const c_void;
    type CFTypeRef = *const c_void;
    type CFAttributedStringRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_AX_ERROR_SUCCESS: AXError = 0;
    const MAX_SNAPSHOT_CHARS: usize = 4_000;
    const MAX_CHILD_DEPTH: usize = 5;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> Boolean;
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(the_array: CFArrayRef) -> CFIndex;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetValueAtIndex(the_array: CFArrayRef, idx: CFIndex) -> *const c_void;
        fn CFAttributedStringGetString(a_str: CFAttributedStringRef) -> CFStringRef;
        fn CFAttributedStringGetTypeID() -> usize;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFRelease(cf: CFTypeRef);
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: CFIndex,
            encoding: u32,
        ) -> Boolean;
        fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
        fn CFStringGetTypeID() -> usize;
    }

    pub fn current_snapshot() -> InputSnapshot {
        if !accessibility_trusted() {
            return InputSnapshot {
                app_name: "需要辅助功能权限".to_string(),
                text: String::new(),
                focused: false,
            };
        }

        unsafe { read_focused_text() }.unwrap_or_else(|| InputSnapshot {
            app_name: "未检测到文本输入框".to_string(),
            text: String::new(),
            focused: false,
        })
    }

    fn accessibility_trusted() -> bool {
        unsafe {
            AXIsProcessTrusted() != 0
        }
    }

    unsafe fn read_focused_text() -> Option<InputSnapshot> {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }

        let app = copy_attribute(system, "AXFocusedApplication");
        CFRelease(system as CFTypeRef);

        let app = app?;
        let app_name = read_string_attribute(app as AXUIElementRef, "AXTitle")
            .or_else(|| read_string_attribute(app as AXUIElementRef, "AXDescription"))
            .unwrap_or_else(|| "当前应用".to_string());

        let focused_element = copy_attribute(app as AXUIElementRef, "AXFocusedUIElement");
        CFRelease(app);

        let focused_element = focused_element?;
        let text = read_focused_element_text(focused_element as AXUIElementRef, 0);
        CFRelease(focused_element);
        let focused = text.is_some();

        Some(InputSnapshot {
            app_name,
            text: text.map(trim_snapshot_text).unwrap_or_default(),
            focused,
        })
    }

    unsafe fn read_focused_element_text(element: AXUIElementRef, depth: usize) -> Option<String> {
        for attribute in ["AXValue", "AXSelectedText", "AXTitle", "AXDescription"] {
            if let Some(value) = read_string_attribute(element, attribute) {
                if !value.trim().is_empty() {
                    return Some(value);
                }
            }
        }

        if depth >= MAX_CHILD_DEPTH {
            return None;
        }

        for attribute in ["AXChildren", "AXVisibleChildren", "AXContents"] {
            if let Some(value) = copy_attribute(element, attribute) {
                let text = read_text_from_children(value, depth + 1);
                CFRelease(value);

                if text.as_deref().is_some_and(|value| !value.trim().is_empty()) {
                    return text;
                }
            }
        }

        None
    }

    unsafe fn read_string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
        let value = copy_attribute(element, attribute)?;
        let string_value = cf_type_to_string(value);
        CFRelease(value);
        string_value
    }

    unsafe fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFTypeRef> {
        let attribute = cf_string(attribute)?;
        let mut value: CFTypeRef = ptr::null();
        let error = AXUIElementCopyAttributeValue(element, attribute, &mut value);
        CFRelease(attribute as CFTypeRef);

        if error == K_AX_ERROR_SUCCESS && !value.is_null() {
            Some(value)
        } else {
            None
        }
    }

    unsafe fn cf_string(attribute: &str) -> Option<CFStringRef> {
        let c_string = CString::new(attribute).ok()?;
        let cf_string =
            CFStringCreateWithCString(ptr::null(), c_string.as_ptr(), K_CF_STRING_ENCODING_UTF8);
        if cf_string.is_null() {
            None
        } else {
            Some(cf_string)
        }
    }

    unsafe fn cf_type_to_string(value: CFTypeRef) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let type_id = CFGetTypeID(value);
        if type_id == CFStringGetTypeID() {
            return cf_string_ref_to_string(value as CFStringRef);
        }

        if type_id == CFAttributedStringGetTypeID() {
            let string_ref = CFAttributedStringGetString(value as CFAttributedStringRef);
            return cf_string_ref_to_string(string_ref);
        }

        None
    }

    unsafe fn cf_string_ref_to_string(string_ref: CFStringRef) -> Option<String> {
        if string_ref.is_null() {
            return None;
        }

        let length = CFStringGetLength(string_ref);
        if length <= 0 {
            return Some(String::new());
        }

        let max_size = CFStringGetMaximumSizeForEncoding(length, K_CF_STRING_ENCODING_UTF8) + 1;
        if max_size <= 1 {
            return Some(String::new());
        }

        let mut buffer = vec![0_i8; max_size as usize];
        let success = CFStringGetCString(
            string_ref,
            buffer.as_mut_ptr(),
            max_size,
            K_CF_STRING_ENCODING_UTF8,
        );

        if success == 0 {
            return None;
        }

        Some(CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned())
    }

    unsafe fn read_text_from_children(value: CFTypeRef, depth: usize) -> Option<String> {
        if value.is_null() || CFGetTypeID(value) != CFArrayGetTypeID() {
            return None;
        }

        let array = value as CFArrayRef;
        let count = CFArrayGetCount(array).min(80);
        for index in 0..count {
            let child = CFArrayGetValueAtIndex(array, index);
            if child.is_null() {
                continue;
            }

            if let Some(text) = read_focused_element_text(child as AXUIElementRef, depth) {
                if !text.trim().is_empty() {
                    return Some(text);
                }
            }
        }

        None
    }

    fn trim_snapshot_text(value: String) -> String {
        let char_count = value.chars().count();
        if char_count <= MAX_SNAPSHOT_CHARS {
            return value;
        }

        value
            .chars()
            .skip(char_count - MAX_SNAPSHOT_CHARS)
            .collect()
    }
}

#[cfg(target_os = "windows")]
fn platform_snapshot() -> InputSnapshot {
    InputSnapshot {
        app_name: "Windows provider pending".to_string(),
        text: String::new(),
        focused: false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_snapshot() -> InputSnapshot {
    InputSnapshot {
        app_name: "Unsupported platform".to_string(),
        text: String::new(),
        focused: false,
    }
}
