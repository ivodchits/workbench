//! Screenshots for Duck (step V3): `screenshot(target, question?)` reads what's on a
//! screen. [`assistant_screenshot`] captures with `xcap` (GDI, so DisplayLink screens
//! work too), downscales to what the model reads well, and encodes PNG in memory;
//! the webview sends it to the model as an `image` block.
//!
//! - Targets: the active window (the foreground one, or the topmost other app's
//!   when Workbench itself is in front, since you're talking to Duck from it), a
//!   monitor by number, a window by title, or every monitor (one image each).
//! - The monitors are numbered left to right and told to the model with where each
//!   one is (left / middle / right, main), so "the right monitor" resolves.
//! - Nothing goes to disk. The last capture stays in memory at full size, and
//!   [`assistant_screenshot_save`] writes it to `Pictures/Workbench` on request.

use std::io::Cursor;
use std::sync::Mutex;

use base64::Engine as _;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use xcap::{Monitor, Window};

/// The longest edge sent, and the most pixels: past these the API scales the image
/// down itself, paying for the bytes on the way.
const MAX_EDGE: u32 = 1568;
const MAX_PIXELS: u32 = 1_150_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// 1-based, left to right.
    pub number: usize,
    pub name: String,
    /// "left", "middle", "right", or "only".
    pub position: &'static str,
    pub main: bool,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    ActiveWindow,
    Monitor { number: usize },
    Window { title: String },
    All,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// What was captured ("monitor 2 (right)", "window: Firefox — …").
    pub label: String,
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    /// The size it was captured at, before downscaling.
    pub source_width: u32,
    pub source_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub shots: Vec<Shot>,
    pub monitors: Vec<MonitorInfo>,
}

/// Captured images with their labels, at full size.
type Raw = Vec<(String, RgbaImage)>;

/// The last capture, for "save it".
#[derive(Default)]
pub struct ScreenState(Mutex<Raw>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Monitors sorted left to right (then top to bottom), with their info.
fn monitors() -> Result<Vec<(Monitor, MonitorInfo)>, String> {
    let mut all: Vec<(Monitor, i32, i32)> = Monitor::all()
        .map_err(err)?
        .into_iter()
        .map(|m| {
            let (x, y) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
            (m, x, y)
        })
        .collect();
    all.sort_by_key(|&(_, x, y)| (x, y));
    let n = all.len();
    Ok(all
        .into_iter()
        .enumerate()
        .map(|(i, (m, _, _))| {
            let name = m
                .friendly_name()
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| m.name().ok())
                .unwrap_or_default()
                .trim()
                .to_string();
            let info = MonitorInfo {
                number: i + 1,
                name,
                position: position(i, n),
                main: m.is_primary().unwrap_or(false),
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
            };
            (m, info)
        })
        .collect())
}

fn position(i: usize, n: usize) -> &'static str {
    match (i, n) {
        (_, 1) => "only",
        (0, _) => "left",
        (i, n) if i + 1 == n => "right",
        _ => "middle",
    }
}

fn monitor_label(m: &MonitorInfo) -> String {
    let main = if m.main { ", main" } else { "" };
    format!("monitor {} ({}{main})", m.number, m.position)
}

/// Windows worth capturing: shown, with a size and a title.
fn windows() -> Result<Vec<Window>, String> {
    Ok(Window::all()
        .map_err(err)?
        .into_iter()
        .filter(|w| {
            !w.is_minimized().unwrap_or(true)
                && w.width().unwrap_or(0) > 1
                && w.height().unwrap_or(0) > 1
                && !w.title().unwrap_or_default().trim().is_empty()
        })
        .collect())
}

fn window_label(w: &Window) -> String {
    let title = w.title().unwrap_or_default();
    let app = w.app_name().unwrap_or_default();
    if app.is_empty() || title.contains(&app) {
        format!("window: {title}")
    } else {
        format!("window: {title} ({app})")
    }
}

/// The foreground window; when that's Workbench, the topmost window of another app.
fn active_window() -> Result<Window, String> {
    let own = std::process::id();
    let mut ws = windows()?;
    if let Some(i) = ws.iter().position(|w| w.is_focused().unwrap_or(false) && w.pid().ok() != Some(own)) {
        return Ok(ws.swap_remove(i));
    }
    ws.retain(|w| w.pid().ok() != Some(own));
    // `z` is higher for windows nearer the front.
    ws.into_iter()
        .max_by_key(|w| w.z().unwrap_or(i32::MIN))
        .ok_or_else(|| "no window of another app is open".into())
}

/// The window whose title (or app) has `title` in it, the frontmost first.
fn window_titled(title: &str) -> Result<Window, String> {
    let want = title.trim().to_lowercase();
    let ws = windows()?;
    let open: Vec<String> = ws.iter().map(|w| w.title().unwrap_or_default()).collect();
    ws.into_iter()
        .filter(|w| {
            w.title().unwrap_or_default().to_lowercase().contains(&want)
                || w.app_name().unwrap_or_default().to_lowercase().contains(&want)
        })
        .max_by_key(|w| w.z().unwrap_or(i32::MIN))
        .ok_or_else(|| {
            let mut list: Vec<&str> = open.iter().map(String::as_str).take(20).collect();
            list.dedup();
            format!("no window has \"{title}\" in its title. Open windows: {}", list.join("; "))
        })
}

/// The size `w`×`h` fits in at most `MAX_EDGE` and `MAX_PIXELS`.
pub fn fit(w: u32, h: u32) -> (u32, u32) {
    let edge = MAX_EDGE as f64 / w.max(h).max(1) as f64;
    let area = (MAX_PIXELS as f64 / (w as f64 * h as f64).max(1.0)).sqrt();
    let s = edge.min(area).min(1.0);
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

fn encode(label: String, img: &RgbaImage) -> Result<Shot, String> {
    let (w, h) = fit(img.width(), img.height());
    let small = if (w, h) == img.dimensions() {
        img.clone()
    } else {
        // Area averaging: text stays readable at a fraction of the size.
        image::imageops::thumbnail(img, w, h)
    };
    // The alpha channel is noise in a screenshot (and GDI leaves it 0 in places).
    let rgb = image::DynamicImage::ImageRgba8(small).into_rgb8();
    let mut png = Vec::new();
    rgb.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).map_err(err)?;
    Ok(Shot {
        label,
        png_base64: base64::engine::general_purpose::STANDARD.encode(&png),
        width: w,
        height: h,
        source_width: img.width(),
        source_height: img.height(),
    })
}

fn capture(target: &Target) -> Result<(Raw, Vec<MonitorInfo>), String> {
    let ms = monitors()?;
    let infos: Vec<MonitorInfo> = ms.iter().map(|(_, i)| i.clone()).collect();
    let shots = match target {
        Target::All => ms
            .iter()
            .map(|(m, i)| Ok((monitor_label(i), m.capture_image().map_err(err)?)))
            .collect::<Result<Vec<_>, String>>()?,
        Target::Monitor { number } => {
            let (m, i) = ms.iter().find(|(_, i)| i.number == *number).ok_or_else(|| {
                let list: Vec<String> = infos.iter().map(monitor_label).collect();
                format!("there's no monitor {number}; the monitors are {}", list.join(", "))
            })?;
            vec![(monitor_label(i), m.capture_image().map_err(err)?)]
        }
        Target::ActiveWindow => {
            let w = active_window()?;
            vec![(window_label(&w), w.capture_image().map_err(err)?)]
        }
        Target::Window { title } => {
            let w = window_titled(title)?;
            vec![(window_label(&w), w.capture_image().map_err(err)?)]
        }
    };
    Ok((shots, infos))
}

#[tauri::command]
pub async fn assistant_screenshot(app: AppHandle, target: Target) -> Result<Capture, String> {
    let (raw, monitors) = tauri::async_runtime::spawn_blocking(move || capture(&target))
        .await
        .map_err(err)??;
    let shots = raw.iter().map(|(label, img)| encode(label.clone(), img)).collect::<Result<Vec<_>, _>>()?;
    *app.state::<ScreenState>().0.lock().unwrap() = raw;
    Ok(Capture { shots, monitors })
}

#[tauri::command]
pub fn assistant_monitors() -> Result<Vec<MonitorInfo>, String> {
    Ok(monitors()?.into_iter().map(|(_, i)| i).collect())
}

/// Write the last capture, full size, to `Pictures/Workbench`; the files written.
#[tauri::command]
pub fn assistant_screenshot_save(app: AppHandle, state: State<'_, ScreenState>) -> Result<Vec<String>, String> {
    let shots = state.0.lock().unwrap();
    if shots.is_empty() {
        return Err("there's no screenshot to save".into());
    }
    let dir = app.path().picture_dir().map_err(err)?.join("Workbench");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut out = Vec::new();
    for (i, (_, img)) in shots.iter().enumerate() {
        let suffix = if shots.len() > 1 { format!("-{}", i + 1) } else { String::new() };
        let path = dir.join(format!("duck-{stamp}{suffix}.png"));
        img.save(&path).map_err(err)?;
        out.push(path.to_string_lossy().into_owned());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_the_edge_and_the_area() {
        assert_eq!(fit(800, 600), (800, 600));
        let (w, h) = fit(3840, 2160);
        assert!(w <= MAX_EDGE && w * h <= MAX_PIXELS + 2000, "{w}x{h}");
        assert_eq!(w * 9 / 16, h);
        assert_eq!(fit(4000, 400).0, MAX_EDGE);
    }

    #[test]
    fn names_positions_left_to_right() {
        assert_eq!(position(0, 1), "only");
        assert_eq!((position(0, 3), position(1, 3), position(2, 3)), ("left", "middle", "right"));
        assert_eq!((position(0, 2), position(1, 2)), ("left", "right"));
    }

    /// Captures the real screens: `cargo test screenshot_captures -- --ignored`.
    #[test]
    #[ignore]
    fn screenshot_captures() {
        let (shots, monitors) = capture(&Target::All).unwrap();
        assert_eq!(shots.len(), monitors.len());
        for (label, img) in &shots {
            let s = encode(label.clone(), img).unwrap();
            println!("{label}: {}x{} -> {}x{}, {} KB", img.width(), img.height(), s.width, s.height, s.png_base64.len() * 3 / 4 / 1024);
        }
        println!("{monitors:?}");
        let (w, _) = capture(&Target::ActiveWindow).unwrap();
        println!("active: {}", w[0].0);
    }
}
