//! The browse commands, as the web app calls them: every argument checked, then handed to the
//! backend with its meaning in the right order.
//!
//! **Arguments are untrusted**, as for the slicer commands (see `slicers::api`): they arrive from a
//! webview, each is validated here with the code the HTTP API would send (`Validation`) instead of
//! being left to the framework's own deserialiser, an argument that is simply absent is a failure
//! (a client that forgot one and one that meant "none" must not be the same request), and an
//! option is `null` when it means nothing.
//!
//! **No command takes a path.** The page names a download id and a project id, and the only
//! strings that cross are ids this process minted. A URL it names (`navigate`, `match`) is decided
//! on in the shell: `navigate` runs it through the browse policy, `match` only keys it.

use std::sync::Arc;

use serde_json::Value;
use spm_core::AppError;
use spm_core::dto::{
    BrowseBounds, BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseStateDto, FileDto,
    ModelSiteDto,
};

/// Longest id of a project (`idSchema`).
pub const MAX_ID_LENGTH: usize = 64;
/// Longest download id: a directory name the sweep found.
pub const MAX_DOWNLOAD_ID_LENGTH: usize = 128;
/// Longest URL the page may hand over: comfortably past anything a site produces.
pub const MAX_URL_LENGTH: usize = 8192;
/// Longest file name (`fileNameSchema`).
pub const MAX_NAME_LENGTH: usize = 255;
/// Beyond this a rectangle is not a rectangle of a screen.
pub const MAX_COORDINATE: f64 = 1_000_000.0;

/// What the commands need from the browser: the one seam between "arguments are valid" and "do it".
pub trait BrowseBackend: Send + Sync {
    fn sites(&self) -> Vec<ModelSiteDto>;
    fn attach(&self, bounds: BrowseBounds, url: Option<&str>) -> Result<BrowseStateDto, AppError>;
    fn detach(&self);
    fn hide(&self);
    fn show(&self) -> BrowseStateDto;
    fn set_bounds(&self, bounds: BrowseBounds);
    fn navigate(&self, url: &str) -> Result<BrowseStateDto, AppError>;
    fn back(&self) -> Result<BrowseStateDto, AppError>;
    fn forward(&self) -> Result<BrowseStateDto, AppError>;
    fn reload(&self) -> Result<BrowseStateDto, AppError>;
    fn state(&self) -> BrowseStateDto;
    fn downloads(&self) -> Vec<BrowseDownloadDto>;
    fn notices(&self) -> Vec<BrowseNoticeDto>;
    fn dismiss_notice(&self, id: &str);
    fn land(
        &self,
        download_id: &str,
        project_id: &str,
        name: Option<&str>,
    ) -> Result<FileDto, AppError>;
    fn discard(&self, download_id: &str) -> Result<(), AppError>;
    fn match_page(&self, url: Option<&str>) -> Result<BrowseMatchDto, AppError>;
    fn clear_last_page(&self);
}

fn missing(name: &str) -> AppError {
    AppError::validation(format!("{name} is required"))
}

fn bad(name: &str, why: &str) -> AppError {
    AppError::validation(format!("{name} {why}"))
}

fn bounded<'a>(value: Option<&'a Value>, name: &str, max: usize) -> Result<&'a str, AppError> {
    let value = value.ok_or_else(|| missing(name))?;
    let text = value
        .as_str()
        .ok_or_else(|| bad(name, "must be a string"))?;
    if text.is_empty() {
        return Err(bad(name, "must not be empty"));
    }
    if text.chars().count() > max {
        return Err(bad(name, "is too long"));
    }
    Ok(text)
}

/// `null` is "nothing"; an absent argument is a mistake.
fn nullable<'a>(
    value: Option<&'a Value>,
    name: &str,
    max: usize,
) -> Result<Option<&'a str>, AppError> {
    match value {
        None => Err(missing(name)),
        Some(Value::Null) => Ok(None),
        some => bounded(some, name, max).map(Some),
    }
}

/// A URL the page hands over: a bounded string with no control characters.
fn url_arg<'a>(value: Option<&'a Value>, name: &str) -> Result<&'a str, AppError> {
    let url = bounded(value, name, MAX_URL_LENGTH)?;
    if url.chars().any(char::is_control) {
        return Err(bad(name, "must not contain control characters"));
    }
    Ok(url)
}

/// `{ x, y, width, height }`, strictly: every key present, every value a finite number of a sane
/// size, nothing else.
pub fn parse_bounds(value: Option<&Value>) -> Result<BrowseBounds, AppError> {
    let value = value.ok_or_else(|| missing("bounds"))?;
    let object = value
        .as_object()
        .ok_or_else(|| bad("bounds", "must be an object"))?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !matches!(key.as_str(), "x" | "y" | "width" | "height"))
    {
        return Err(bad("bounds", &format!("has an unknown key: {unknown}")));
    }
    let number = |key: &str| -> Result<f64, AppError> {
        let value = object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && number.abs() <= MAX_COORDINATE)
            .ok_or_else(|| bad(&format!("bounds.{key}"), "must be a finite number"))?;
        Ok(value)
    };
    let (width, height) = (number("width")?, number("height")?);
    if width < 0.0 || height < 0.0 {
        return Err(bad("bounds", "must not have a negative size"));
    }
    Ok(BrowseBounds {
        x: number("x")?,
        y: number("y")?,
        width,
        height,
    })
}

/// The commands, each over raw arguments. The Tauri glue is one line per command.
pub struct BrowseCommands {
    backend: Arc<dyn BrowseBackend>,
}

impl BrowseCommands {
    pub fn new(backend: Arc<dyn BrowseBackend>) -> BrowseCommands {
        BrowseCommands { backend }
    }

    pub fn sites(&self) -> Vec<ModelSiteDto> {
        self.backend.sites()
    }

    /// `url` is `null` to open on the remembered page.
    pub fn attach(
        &self,
        bounds: Option<&Value>,
        url: Option<&Value>,
    ) -> Result<BrowseStateDto, AppError> {
        let bounds = parse_bounds(bounds)?;
        let url = match url {
            None | Some(Value::Null) => None,
            some => Some(url_arg(some, "url")?),
        };
        self.backend.attach(bounds, url)
    }

    pub fn detach(&self) {
        self.backend.detach();
    }

    pub fn hide(&self) {
        self.backend.hide();
    }

    pub fn show(&self) -> BrowseStateDto {
        self.backend.show()
    }

    pub fn set_bounds(&self, bounds: Option<&Value>) -> Result<(), AppError> {
        self.backend.set_bounds(parse_bounds(bounds)?);
        Ok(())
    }

    pub fn navigate(&self, url: Option<&Value>) -> Result<BrowseStateDto, AppError> {
        self.backend.navigate(url_arg(url, "url")?)
    }

    pub fn back(&self) -> Result<BrowseStateDto, AppError> {
        self.backend.back()
    }

    pub fn forward(&self) -> Result<BrowseStateDto, AppError> {
        self.backend.forward()
    }

    pub fn reload(&self) -> Result<BrowseStateDto, AppError> {
        self.backend.reload()
    }

    pub fn state(&self) -> BrowseStateDto {
        self.backend.state()
    }

    pub fn downloads(&self) -> Vec<BrowseDownloadDto> {
        self.backend.downloads()
    }

    pub fn notices(&self) -> Vec<BrowseNoticeDto> {
        self.backend.notices()
    }

    pub fn dismiss_notice(&self, id: Option<&Value>) -> Result<(), AppError> {
        self.backend
            .dismiss_notice(bounded(id, "id", MAX_DOWNLOAD_ID_LENGTH)?);
        Ok(())
    }

    /// `name` is `null` to keep the download's own.
    pub fn land(
        &self,
        download_id: Option<&Value>,
        project_id: Option<&Value>,
        name: Option<&Value>,
    ) -> Result<FileDto, AppError> {
        let download_id = bounded(download_id, "downloadId", MAX_DOWNLOAD_ID_LENGTH)?;
        let project_id = bounded(project_id, "projectId", MAX_ID_LENGTH)?;
        let name = nullable(name, "name", MAX_NAME_LENGTH)?;
        self.backend.land(download_id, project_id, name)
    }

    pub fn discard(&self, download_id: Option<&Value>) -> Result<(), AppError> {
        self.backend
            .discard(bounded(download_id, "downloadId", MAX_DOWNLOAD_ID_LENGTH)?)
    }

    /// `url` is `null` to match nothing (a download no page is known for).
    pub fn match_page(&self, url: Option<&Value>) -> Result<BrowseMatchDto, AppError> {
        let url = match url {
            None => return Err(missing("url")),
            Some(Value::Null) => None,
            some => Some(url_arg(some, "url")?),
        };
        self.backend.match_page(url)
    }

    pub fn clear_last_page(&self) {
        self.backend.clear_last_page();
    }
}
