use wasapi::{DeviceEnumerator, Direction as WasapiDirection, initialize_mta};

use crate::audio::error::AudioError;
use crate::audio::types::{AudioDeviceInfo, DeviceDirection};

pub fn list_devices() -> Result<Vec<AudioDeviceInfo>, AudioError> {
    let _ = initialize_mta();
    let enumerator = DeviceEnumerator::new()?;
    let default_render = enumerator
        .get_default_device(&WasapiDirection::Render)
        .ok()
        .and_then(|device| device.get_id().ok());
    let default_capture = enumerator
        .get_default_device(&WasapiDirection::Capture)
        .ok()
        .and_then(|device| device.get_id().ok());

    let mut devices = Vec::new();
    for (direction, default_id) in [
        (DeviceDirection::Render, default_render),
        (DeviceDirection::Capture, default_capture),
    ] {
        let wasapi_direction = match direction {
            DeviceDirection::Render => WasapiDirection::Render,
            DeviceDirection::Capture => WasapiDirection::Capture,
        };
        let collection = enumerator.get_device_collection(&wasapi_direction)?;
        for device in &collection {
            let device = device?;
            let id = device.get_id()?;
            let name = device.get_friendlyname()?;
            devices.push(AudioDeviceInfo {
                is_default: default_id.as_deref() == Some(id.as_str()),
                id,
                name,
                direction,
            });
        }
    }
    Ok(devices)
}
