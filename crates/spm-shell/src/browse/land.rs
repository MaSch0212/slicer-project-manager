//! A staged download becoming a file of a project, and a page being matched to the projects it may
//! be the source of.
//!
//! **Never automatic.** The user names the project, always: a first download matches nothing, by
//! definition, because the project does not exist yet (which is why the user is on the site). The
//! landing goes through the library API ([`super::api`]) so the quota check, the name clash and
//! every other rule are the server's. **The renderer names a download id and a project id, never a
//! path**: the staging directory and the record are this process's, and the only strings that
//! cross the boundary are ids this process minted and matches against records it enumerated.
//!
//! A landed download's directory is removed once the upload has returned; a failed upload leaves
//! it, so the user can try again. A name clash is reported and not worked around (`benchy-1.zip`
//! beside `benchy.zip` would hide the fact that the user already has this model).

use std::sync::Arc;

use serde_json::Value;
use spm_core::dto::{BrowseMatchDto, BrowseMatchProjectDto, FileDto};
use spm_core::{AppError, content_type_for, validate};

use super::api::LibrarySource;
use super::downloads::{Downloads, StagedDownload};
use super::last_page::MAX_REMEMBERED_URL;
use super::policy::is_http_url;
use super::registry::SiteRegistry;
use crate::slicers::remote_files::{failure_of, remote_upload};

pub struct BrowseLanding {
    downloads: Arc<Downloads>,
    library: LibrarySource,
}

impl BrowseLanding {
    pub fn new(downloads: Arc<Downloads>, library: LibrarySource) -> BrowseLanding {
        BrowseLanding { downloads, library }
    }

    /// Lands `download_id` into `project_id` as a new file named `name` (default: the download's
    /// own name).
    pub fn land(
        &self,
        download_id: &str,
        project_id: &str,
        name: Option<&str>,
    ) -> Result<FileDto, AppError> {
        let staged = self.downloads.find(download_id).ok_or_else(|| {
            AppError::not_found("there is no staged download with that id")
                .with_details(details(download_id))
        })?;
        if !staged.is_verifiable {
            return Err(
                AppError::conflict(why_unlandable(&staged)).with_details(details(download_id))
            );
        }
        let size = size_on_disk(&staged.file_path)?;
        if size != staged.bytes_on_disk {
            return Err(AppError::conflict(format!(
                "that download is {size} bytes now and was {} when this app last checked it, so nothing can vouch for it",
                staged.bytes_on_disk
            ))
            .with_details(details(download_id)));
        }
        let name = name_for(&staged, name)?;
        let library = (self.library)()?;
        let landed = remote_upload(
            library.as_ref(),
            project_id,
            &name,
            &staged.file_path,
            u64::try_from(size).unwrap_or(0),
            content_type_for(&name),
        )?;
        let file: FileDto = serde_json::from_value(landed)
            .map_err(|_| AppError::internal("the library did not answer with a file"))?;
        self.downloads.remove(download_id);
        Ok(file)
    }
}

fn details(download_id: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("downloadId".to_owned(), Value::from(download_id));
    map
}

fn why_unlandable(staged: &StagedDownload) -> String {
    use spm_core::dto::BrowseDownloadState::Completed;
    if !staged.has_record {
        "no record of this download could be read, so nothing can say whether these bytes are complete"
            .to_owned()
    } else if staged.record.state != Completed {
        let state = serde_json::to_value(staged.record.state)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        format!("that download ended as {state}, so its bytes are not the whole file")
    } else if staged.record.total_bytes == 0 {
        "that download declared no size and this app did not watch it finish, so nothing can vouch for its bytes"
            .to_owned()
    } else {
        format!(
            "that download is not the {} bytes it declared, so it is not the whole file",
            staged.record.total_bytes
        )
    }
}

fn name_for(staged: &StagedDownload, requested: Option<&str>) -> Result<String, AppError> {
    let name = requested.unwrap_or(&staged.record.file_name);
    validate::file_name(name)
        .map_err(|_| AppError::validation("that is not a name a file can have"))?;
    Ok(name.to_owned())
}

fn size_on_disk(path: &std::path::Path) -> Result<i64, AppError> {
    std::fs::metadata(path)
        .map(|meta| i64::try_from(meta.len()).unwrap_or(i64::MAX))
        .map_err(|_| {
            AppError::not_found("the bytes of that download are no longer where it staged them")
        })
}

/// Which of the user's projects `url` may be the source of, by `projects.website` and the match
/// key. **A suggestion, never applied silently**; an empty list is the honest, common answer, and
/// is not an error. `url` that is not an `http(s)` page (a popup download has none) is not keyed.
pub fn match_projects(
    registry: &SiteRegistry,
    library: &LibrarySource,
    url: Option<&str>,
) -> Result<BrowseMatchDto, AppError> {
    let url = url.filter(|url| is_http_url(url, MAX_REMEMBERED_URL));
    let Some(url) = url else {
        return Ok(BrowseMatchDto {
            url: None,
            key: None,
            projects: Vec::new(),
        });
    };
    let key = registry.match_key(url);
    let library = library()?;
    let response = library.get("/projects?includeArchived=true")?;
    if !response.is_ok() {
        return Err(failure_of(&response, "could not read the projects"));
    }
    let list: Value = serde_json::from_slice(&response.body)
        .map_err(|_| AppError::internal("the library did not answer with a project list"))?;
    let mut projects: Vec<BrowseMatchProjectDto> = list
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|project| {
            let website = project.get("website")?.as_str()?;
            // Only a project whose own website is a page this could key.
            (is_http_url(website, MAX_REMEMBERED_URL) && registry.match_key(website) == key)
                .then(|| {
                    Some(BrowseMatchProjectDto {
                        id: project.get("id")?.as_str()?.to_owned(),
                        name: project.get("name")?.as_str()?.to_owned(),
                    })
                })
                .flatten()
        })
        .collect();
    projects.sort_by_key(|project| project.name.to_lowercase());
    Ok(BrowseMatchDto {
        url: Some(url.to_owned()),
        key: Some(key),
        projects,
    })
}
