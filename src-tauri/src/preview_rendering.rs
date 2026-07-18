use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use image::{DynamicImage, GenericImageView, ImageBuffer, Luma};
use mozjpeg_rs::{Encoder, Preset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::adjustment_utils::hydrate_adjustments;
use crate::app_settings::{AppSettings, load_settings};
use crate::app_state::{AppState, LoadedImage};
use crate::cache_utils::calculate_full_job_hash;
use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::formats::is_raw_file;
use crate::gpu_processing::Roi;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::{
    RenderRequest, apply_cpu_default_raw_processing, apply_geometry_warp, downscale_f32_image,
    get_all_adjustments_from_json, get_or_init_gpu_context, process_and_get_dynamic_image,
    resolve_tonemapper_override,
};
use crate::mask_generation::{MaskDefinition, generate_mask_bitmap};
use crate::{compute_full_transformed_res, lut_processing, runtime_preview_cache};

pub const LOUPE_RENDER_CONCURRENCY: usize = 1;

fn get_or_decode_loupe_base_image(
    source_path: &Path,
    source_path_str: &str,
    source_identity: &str,
    state: &tauri::State<AppState>,
    settings: &AppSettings,
) -> Result<Arc<DynamicImage>, String> {
    if let Some((cached_img, _)) = state
        .decoded_image_cache
        .lock()
        .unwrap()
        .get(source_identity)
    {
        state
            .loupe_decoded_cache_keys
            .lock()
            .unwrap()
            .insert(source_identity.to_string());
        return Ok(cached_img);
    }

    let (decoded, exif_data) = match read_file_mapped(source_path) {
        Ok(mmap) => {
            let image = load_base_image_from_bytes(&mmap, source_path_str, false, settings, None)
                .map_err(|e| e.to_string())?;
            let exif = crate::exif_processing::read_exif_data(source_path_str, &mmap);
            (image, exif)
        }
        Err(e) => {
            log::warn!(
                "Failed to memory-map file '{}': {}. Falling back to standard read.",
                source_path_str,
                e
            );
            let bytes = fs::read(source_path).map_err(|io_err| io_err.to_string())?;
            let image = load_base_image_from_bytes(&bytes, source_path_str, false, settings, None)
                .map_err(|e| e.to_string())?;
            let exif = crate::exif_processing::read_exif_data(source_path_str, &bytes);
            (image, exif)
        }
    };

    let arc_img = Arc::new(decoded);
    state.decoded_image_cache.lock().unwrap().insert(
        source_identity.to_string(),
        Arc::clone(&arc_img),
        exif_data,
    );
    state
        .loupe_decoded_cache_keys
        .lock()
        .unwrap()
        .insert(source_identity.to_string());

    Ok(arc_img)
}

fn get_or_compute_loupe_transformed_image(
    source_identity: &str,
    loaded_image: &LoadedImage,
    adjustments: &Value,
    state: &tauri::State<AppState>,
) -> Result<(Arc<DynamicImage>, (f32, f32)), String> {
    const LOUPE_TRANSFORM_CACHE_CAPACITY: usize = 4;
    let cache_key = calculate_full_job_hash(source_identity, adjustments);

    {
        let mut cache = state.loupe_transformed_cache.lock().unwrap();
        if let Some(pos) = cache.iter().position(|(hash, _, _)| *hash == cache_key) {
            let item = cache.remove(pos);
            let result = (Arc::clone(&item.1), item.2);
            cache.push(item);
            return Ok(result);
        }
    }

    let (transformed_image, unscaled_crop_offset) =
        compute_full_transformed_res(loaded_image, adjustments)?;

    {
        let mut cache = state.loupe_transformed_cache.lock().unwrap();
        if cache.len() >= LOUPE_TRANSFORM_CACHE_CAPACITY {
            cache.remove(0);
        }
        cache.push((
            cache_key,
            Arc::clone(&transformed_image),
            unscaled_crop_offset,
        ));
    }

    Ok((transformed_image, unscaled_crop_offset))
}

fn compute_loupe_roi(
    width: u32,
    height: u32,
    center_x: f32,
    center_y: f32,
    source_size: u32,
) -> Roi {
    let requested_size = source_size.max(1);
    let roi_width = requested_size.min(width.max(1));
    let roi_height = requested_size.min(height.max(1));
    let center_px = (center_x.clamp(0.0, 1.0) * width as f32).round() as i64;
    let center_py = (center_y.clamp(0.0, 1.0) * height as f32).round() as i64;
    let max_x = width.saturating_sub(roi_width) as i64;
    let max_y = height.saturating_sub(roi_height) as i64;
    let x = (center_px - roi_width as i64 / 2).clamp(0, max_x) as u32;
    let y = (center_py - roi_height as i64 / 2).clamp(0, max_y) as u32;

    Roi {
        x,
        y,
        width: roi_width,
        height: roi_height,
    }
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct PreviewImageDimensions {
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct LoupeTileRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryPreviewSidecar {
    version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPreviewResponse {
    preview_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoupeTileSidecar {
    version: u32,
    source_rect: LoupeTileRect,
    image_size: PreviewImageDimensions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoupeTileResponse {
    tile_path: String,
    source_rect: LoupeTileRect,
    image_size: PreviewImageDimensions,
}

struct PreparedLoupeTileRequest {
    path: String,
    adjustments: Value,
    center_x: f32,
    center_y: f32,
    tile_source_size: Option<u32>,
    settings: AppSettings,
    source_path: PathBuf,
    source_path_str: String,
    cache_key: String,
    jpg_path: PathBuf,
    json_path: PathBuf,
}

fn image_path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn read_library_preview_cache(jpg_path: &Path, json_path: &Path) -> Option<LibraryPreviewResponse> {
    if !jpg_path.exists() || !json_path.exists() {
        return None;
    }

    let sidecar = fs::read_to_string(json_path)
        .ok()
        .and_then(|json| serde_json::from_str::<LibraryPreviewSidecar>(&json).ok())?;
    if sidecar.version != runtime_preview_cache::LIBRARY_PREVIEW_VERSION {
        return None;
    }

    Some(LibraryPreviewResponse {
        preview_path: image_path_string(jpg_path),
    })
}

fn read_loupe_tile_cache(jpg_path: &Path, json_path: &Path) -> Option<LoupeTileResponse> {
    if !jpg_path.exists() || !json_path.exists() {
        return None;
    }

    let sidecar = fs::read_to_string(json_path)
        .ok()
        .and_then(|json| serde_json::from_str::<LoupeTileSidecar>(&json).ok())?;
    if sidecar.version != runtime_preview_cache::LOUPE_TILE_VERSION {
        return None;
    }

    Some(LoupeTileResponse {
        tile_path: image_path_string(jpg_path),
        source_rect: sidecar.source_rect,
        image_size: sidecar.image_size,
    })
}

fn read_and_track_loupe_tile_cache(
    state: &AppState,
    jpg_path: &Path,
    json_path: &Path,
) -> Option<LoupeTileResponse> {
    let response = read_loupe_tile_cache(jpg_path, json_path)?;
    runtime_preview_cache::track_entry(
        state,
        runtime_preview_cache::RuntimePreviewKind::Loupe,
        jpg_path.to_path_buf(),
        json_path.to_path_buf(),
    );
    Some(response)
}

fn render_settings_cache_key(settings: &AppSettings) -> String {
    serde_json::json!({
        "rawHighlightCompression": settings.raw_highlight_compression,
        "linearRawMode": &settings.linear_raw_mode,
        "rawPreprocessingColorNr": settings.raw_preprocessing_color_nr,
        "rawPreprocessingSharpening": settings.raw_preprocessing_sharpening,
        "applyPreprocessingToNonRaws": settings.apply_preprocessing_to_non_raws,
        "tonemapperOverrideEnabled": settings.tonemapper_override_enabled,
        "defaultRawTonemapper": &settings.default_raw_tonemapper,
        "defaultNonRawTonemapper": &settings.default_non_raw_tonemapper,
    })
    .to_string()
}

fn compute_library_preview_cache_key(path: &str, target_edge: u32, settings_key: &str) -> String {
    let (source_path, sidecar_path) = parse_virtual_path(path);
    let source_path_str = image_path_string(&source_path);
    let modified = runtime_preview_cache::file_modified_key(&source_path);
    let sidecar_hash = runtime_preview_cache::file_identity_key(&sidecar_path);
    let bucket = target_edge.to_string();
    let quality = runtime_preview_cache::LIBRARY_PREVIEW_JPEG_QUALITY.to_string();
    let cache_namespace = format!(
        "library-preview-v{}",
        runtime_preview_cache::LIBRARY_PREVIEW_VERSION
    );

    runtime_preview_cache::hash_cache_parts(&[
        &cache_namespace,
        path,
        &source_path_str,
        &modified,
        &sidecar_hash,
        settings_key,
        &bucket,
        &quality,
    ])
}

fn compute_loupe_tile_cache_key(
    path: &str,
    source_path: &Path,
    adjustments: &Value,
    tile_source_size: Option<u32>,
    center_x: f32,
    center_y: f32,
    settings_key: &str,
) -> String {
    let source_path_str = source_path.to_string_lossy();
    let modified = runtime_preview_cache::file_modified_key(source_path);
    let adjustments_key = adjustments.to_string();
    let is_full_tile = tile_source_size.is_none();
    let tile_source_size = tile_source_size
        .map(|value| value.clamp(64, 4096).to_string())
        .unwrap_or_else(|| "full".to_string());
    let center_x = if is_full_tile {
        "full".to_string()
    } else {
        format!("{:.6}", center_x.clamp(0.0, 1.0))
    };
    let center_y = if is_full_tile {
        "full".to_string()
    } else {
        format!("{:.6}", center_y.clamp(0.0, 1.0))
    };
    let quality = runtime_preview_cache::LOUPE_TILE_JPEG_QUALITY.to_string();
    let cache_namespace = format!("loupe-tile-v{}", runtime_preview_cache::LOUPE_TILE_VERSION);

    runtime_preview_cache::hash_cache_parts(&[
        &cache_namespace,
        path,
        &source_path_str,
        &modified,
        &adjustments_key,
        settings_key,
        &tile_source_size,
        &center_x,
        &center_y,
        &quality,
    ])
}

fn prepare_loupe_tile_request(
    path: String,
    mut adjustments: Value,
    center_x: f32,
    center_y: f32,
    tile_source_size: Option<u32>,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
) -> Result<PreparedLoupeTileRequest, String> {
    hydrate_adjustments(state, &mut adjustments);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let settings_key = render_settings_cache_key(&settings);
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();
    let cache_key = compute_loupe_tile_cache_key(
        &path,
        &source_path,
        &adjustments,
        tile_source_size,
        center_x,
        center_y,
        &settings_key,
    );
    let (jpg_path, json_path) = runtime_preview_cache::cache_paths(
        app_handle,
        state,
        runtime_preview_cache::RuntimePreviewKind::Loupe,
        &cache_key,
    )?;

    Ok(PreparedLoupeTileRequest {
        path,
        adjustments,
        center_x,
        center_y,
        tile_source_size,
        settings,
        source_path,
        source_path_str,
        cache_key,
        jpg_path,
        json_path,
    })
}

fn render_loupe_tile_request(
    request: PreparedLoupeTileRequest,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
) -> Result<LoupeTileResponse, String> {
    let PreparedLoupeTileRequest {
        path,
        adjustments,
        center_x,
        center_y,
        tile_source_size,
        settings,
        source_path,
        source_path_str,
        cache_key,
        jpg_path,
        json_path,
    } = request;
    let app_state: &AppState = state;

    runtime_preview_cache::with_render_lock(
        app_handle,
        app_state,
        runtime_preview_cache::RuntimePreviewKind::Loupe,
        &cache_key,
        || {
            if let Some(response) =
                read_and_track_loupe_tile_cache(app_state, &jpg_path, &json_path)
            {
                return Ok(response);
            }

            let context = get_or_init_gpu_context(state, app_handle)?;
            let is_raw = is_raw_file(&source_path_str);
            let source_identity = format!(
                "{}:{}",
                source_path_str,
                runtime_preview_cache::file_identity_key(&source_path)
            );
            let base_arc = get_or_decode_loupe_base_image(
                &source_path,
                &source_path_str,
                &source_identity,
                state,
                &settings,
            )?;
            let loaded_image = LoadedImage {
                path: path.clone(),
                image: Arc::clone(&base_arc),
                is_raw,
            };

            let (transformed_image, unscaled_crop_offset) = get_or_compute_loupe_transformed_image(
                &source_identity,
                &loaded_image,
                &adjustments,
                state,
            )?;
            let (img_w, img_h) = transformed_image.dimensions();
            if img_w == 0 || img_h == 0 {
                return Err("Cannot render loupe for an empty image.".to_string());
            }

            let tile_source_size = tile_source_size
                .map(|value| value.clamp(64, 4096))
                .unwrap_or_else(|| img_w.max(img_h));
            let roi = compute_loupe_roi(img_w, img_h, center_x, center_y, tile_source_size);

            let mask_definitions: Vec<MaskDefinition> = adjustments
                .get("masks")
                .and_then(|m| serde_json::from_value(m.clone()).ok())
                .unwrap_or_default();

            let warped_image = if mask_definitions
                .iter()
                .any(|def| def.requires_warped_image())
            {
                let mut full_image = (*base_arc).clone();
                if is_raw {
                    apply_cpu_default_raw_processing(&mut full_image);
                }
                Some(Arc::new(
                    apply_geometry_warp(Cow::Borrowed(&full_image), &adjustments).into_owned(),
                ))
            } else {
                None
            };

            let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
                .iter()
                .filter_map(|def| {
                    generate_mask_bitmap(
                        def,
                        img_w,
                        img_h,
                        1.0,
                        unscaled_crop_offset,
                        warped_image.as_deref(),
                    )
                })
                .collect();

            let tm_override = resolve_tonemapper_override(&settings, is_raw);
            let all_adjustments = get_all_adjustments_from_json(&adjustments, is_raw, tm_override);
            let lut_path = adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| lut_processing::get_or_load_lut(state, p).ok());
            let unique_hash = calculate_full_job_hash(&source_path_str, &adjustments);
            let mut final_image = process_and_get_dynamic_image(
                &context,
                state,
                transformed_image.as_ref(),
                unique_hash,
                RenderRequest {
                    adjustments: all_adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut,
                    roi: Some(roi),
                },
                "generate_loupe_tile",
            )?;

            if (final_image.width() != roi.width || final_image.height() != roi.height)
                && final_image.width() >= roi.x + roi.width
                && final_image.height() >= roi.y + roi.height
            {
                final_image = final_image.crop_imm(roi.x, roi.y, roi.width, roi.height);
            }

            let (width, height) = final_image.dimensions();
            let rgb_pixels = final_image.to_rgb8().into_vec();
            let bytes = Encoder::new(Preset::BaselineFastest)
                .quality(runtime_preview_cache::LOUPE_TILE_JPEG_QUALITY)
                .encode_rgb(&rgb_pixels, width, height)
                .map_err(|e| format!("Failed to encode loupe tile with mozjpeg-rs: {}", e))?;

            let source_rect = LoupeTileRect {
                x: roi.x,
                y: roi.y,
                width: roi.width,
                height: roi.height,
            };
            let image_size = PreviewImageDimensions {
                width: img_w,
                height: img_h,
            };
            let sidecar = LoupeTileSidecar {
                version: runtime_preview_cache::LOUPE_TILE_VERSION,
                source_rect,
                image_size,
            };

            runtime_preview_cache::write_entry(
                app_state,
                runtime_preview_cache::RuntimePreviewKind::Loupe,
                &jpg_path,
                &bytes,
                &json_path,
                &sidecar,
            )?;

            Ok(LoupeTileResponse {
                tile_path: image_path_string(&jpg_path),
                source_rect,
                image_size,
            })
        },
    )
}

#[tauri::command]
pub async fn generate_loupe_tile(
    path: String,
    js_adjustments: Value,
    center_x: f32,
    center_y: f32,
    tile_source_size: Option<u32>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<LoupeTileResponse, String> {
    let generation = state.loupe_render_generation.load(Ordering::SeqCst);
    let request = prepare_loupe_tile_request(
        path,
        js_adjustments,
        center_x,
        center_y,
        tile_source_size,
        &state,
        &app_handle,
    )?;

    if let Some(response) =
        read_and_track_loupe_tile_cache(&state, &request.jpg_path, &request.json_path)
    {
        return Ok(response);
    }

    let permit = state
        .loupe_render_semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Loupe render queue closed.".to_string())?;

    if generation != state.loupe_render_generation.load(Ordering::SeqCst) {
        return Err("Loupe render request is no longer active.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let state = app_handle.state::<AppState>();
        render_loupe_tile_request(request, &state, &app_handle)
    })
    .await
    .map_err(|e| format!("Loupe render task failed: {}", e))?
}

fn render_library_preview_for_path(
    path: &str,
    max_edge: u32,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
) -> Result<LibraryPreviewResponse, String> {
    let target_edge = max_edge.clamp(256, 5120);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let settings_key = render_settings_cache_key(&settings);
    let cache_key = compute_library_preview_cache_key(path, target_edge, &settings_key);
    let app_state: &AppState = state;
    let (jpg_path, json_path) = runtime_preview_cache::cache_paths(
        app_handle,
        app_state,
        runtime_preview_cache::RuntimePreviewKind::Library,
        &cache_key,
    )?;

    if let Some(response) = read_library_preview_cache(&jpg_path, &json_path) {
        runtime_preview_cache::track_entry(
            app_state,
            runtime_preview_cache::RuntimePreviewKind::Library,
            jpg_path,
            json_path,
        );
        return Ok(response);
    }

    runtime_preview_cache::with_render_lock(
        app_handle,
        app_state,
        runtime_preview_cache::RuntimePreviewKind::Library,
        &cache_key,
        || {
            if let Some(response) = read_library_preview_cache(&jpg_path, &json_path) {
                runtime_preview_cache::track_entry(
                    app_state,
                    runtime_preview_cache::RuntimePreviewKind::Library,
                    jpg_path.clone(),
                    json_path.clone(),
                );
                return Ok(response);
            }

            let context = get_or_init_gpu_context(state, app_handle).ok();
            let preview_image =
                crate::file_management::generate_library_preview_data_at_resolution(
                    path,
                    context.as_ref(),
                    None,
                    app_handle,
                    target_edge,
                )
                .map_err(|e| e.to_string())?;

            let output_image =
                if preview_image.width() > target_edge || preview_image.height() > target_edge {
                    downscale_f32_image(&preview_image, target_edge, target_edge)
                } else {
                    preview_image
                };

            let (width, height) = output_image.dimensions();
            let rgb_pixels = output_image.to_rgb8().into_vec();
            let bytes = Encoder::new(Preset::BaselineFastest)
                .quality(runtime_preview_cache::LIBRARY_PREVIEW_JPEG_QUALITY)
                .encode_rgb(&rgb_pixels, width, height)
                .map_err(|e| format!("Failed to encode library preview: {}", e))?;
            let sidecar = LibraryPreviewSidecar {
                version: runtime_preview_cache::LIBRARY_PREVIEW_VERSION,
            };

            runtime_preview_cache::write_entry(
                app_state,
                runtime_preview_cache::RuntimePreviewKind::Library,
                &jpg_path,
                &bytes,
                &json_path,
                &sidecar,
            )?;

            Ok(LibraryPreviewResponse {
                preview_path: image_path_string(&jpg_path),
            })
        },
    )
}

#[tauri::command]
pub async fn generate_library_preview_for_path(
    path: String,
    max_edge: u32,
    app_handle: tauri::AppHandle,
) -> Result<LibraryPreviewResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        render_library_preview_for_path(&path, max_edge, &state, &app_handle)
    })
    .await
    .map_err(|e| format!("Library preview render task failed: {}", e))?
}

#[tauri::command]
pub fn set_active_loupe_preview_paths(paths: Vec<String>, state: tauri::State<AppState>) {
    runtime_preview_cache::set_active_loupe_preview_paths(&state, paths);
}
