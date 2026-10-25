//! The model browser's part of the hidden smoke run: the **real child webview**, driven through the
//! real bridge, against a fixture server standing in for a model site. Nothing here touches one of
//! the four real sites (Cloudflare, consent banners and the network would make a test that fails
//! when somebody else's server is slow).
//!
//! `SPM_DESKTOP_SMOKE_BROWSE=<fixture origin>` turns it on, and the registry must name the fixture
//! as a site (`SPM_DESKTOP_BROWSE_TEST_HOSTS=thingiverse=<host:port>`, debug builds only). The
//! fixture impersonates the behaviours the sites are measured to have: a `blob:` download by the
//! three DOM idioms, an attachment, a redirect into a custom scheme, `target=_blank`, a deferred
//! `window.open`, geolocation, and storage.
//!
//! Two halves:
//!
//! - **Through the bridge** ([`BROWSE_MAIN_JS`], run in the main webview): attach, bounds, the
//!   navigation policy, the four download paths, the match, the landing into a project over the
//!   loopback API, discard, detach. This is every command of the subsystem called the way the page
//!   calls it.
//! - **From the view's side** (Rust attaches it and reads what its own pages report through the
//!   document title): that an `invoke` from the browse webview is **refused**, that it cannot
//!   reach the loopback API without the launch secret (the server's request log, which only
//!   records requests that passed the gate), that its storage is **isolated** from the main
//!   webview's both ways and persists across a re-attach, and that it is denied geolocation.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use spm_shell::server::ServerHandle;
use spm_shell::smoke::{Check, SmokeReport};
use tauri::{AppHandle, Manager, Position, Runtime, Size, WebviewWindow};

use crate::browse::BROWSE_WEBVIEW;
use crate::commands::AppCtx;
use crate::hidden::Probes;

const STEP_WAIT: Duration = Duration::from_secs(60);

/// Progress, on stderr: a smoke run that hangs says where.
fn note(message: &str) {
    spm_shell::diag::warn(&format!("browse smoke: {message}"));
}

/// Run in the main webview: every browse command through `invoke`.
const BROWSE_MAIN_JS: &str = r#"
(async () => {
  const FIX = '__FIX__';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = async (command, args) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
    } catch (error) {
      return { ok: false, error: typeof error === 'string' ? error : JSON.stringify(error) };
    }
  };
  const until = async (probe, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(150);
    }
  };
  const report = (value) => { document.title = 'PROBE:' + JSON.stringify(value); };
  const state = async () => {
    const answer = await call('desktop_browse_state');
    return answer.ok ? answer.value : null;
  };
  const settled = (title) => until(async () => {
    const s = await state();
    return s && s.attached && s.title === title && !s.isLoading ? s : null;
  });
  const downloads = async () => {
    const answer = await call('desktop_browse_downloads');
    return answer.ok ? answer.value : [];
  };
  const out = { step: 'browse-main' };
  const started = Date.now();
  const phase = (name) => report({ step: 'phase', name, seconds: Math.round((Date.now() - started) / 1000) });
  const brief = (s) => s && {
    attached: s.attached, url: s.url, title: s.title, siteId: s.siteId, lastError: s.lastError,
  };

  try {
  const sites = await call('desktop_browse_sites');
  out.sites = { ok: sites.ok, count: sites.ok ? sites.value.length : 0 };
  out.refusedWithNoView = await call('desktop_browse_navigate', { url: FIX + '/second' });
  out.badBounds = await call('desktop_browse_attach', { bounds: { x: 'a' }, url: null });

  // Bounds: a request for far more than the window is intersected, a 1x1 request applies nothing.
  const attach = await call('desktop_browse_attach', {
    bounds: { x: 0, y: 0, width: 6000, height: 6000 },
    url: FIX + '/thing:7401409/files',
  });
  out.attach = { ok: attach.ok, attached: attach.ok && attach.value.attached };
  out.thing = brief(await settled('fixture:thing'));
  window.__spmGo = null;
  report({ step: 'bounds-whole' });
  await until(() => window.__spmGo === 'tiny', 20000);
  out.tinyAnswer = await call('desktop_browse_set_bounds', { bounds: { x: 300, y: 300, width: 1, height: 1 } });
  report({ step: 'bounds-tiny' });
  await until(() => window.__spmGo === 'normal', 20000);
  out.normalAnswer = await call('desktop_browse_set_bounds', { bounds: { x: 100, y: 200, width: 700, height: 400 } });
  out.hide = await call('desktop_browse_hide');
  const shown = await call('desktop_browse_show');
  out.show = { ok: shown.ok };
  report({ step: 'bounds-normal' });
  await until(() => window.__spmGo === 'done', 20000);

  // The navigation policy, from inside real pages.
  const policy = {};
  phase('policy');
  await call('desktop_browse_navigate', { url: FIX + '/custom-scheme' });
  policy.customScheme = brief(await until(async () => {
    const s = await state();
    return s && s.lastError ? s : null;
  }));
  await call('desktop_browse_navigate', { url: FIX + '/go-redirect-custom' });
  await sleep(1500);
  policy.redirectCustom = brief(await state());
  await call('desktop_browse_navigate', { url: FIX + '/go-redirect-ok' });
  policy.redirectOk = brief(await settled('fixture:thing'));
  await call('desktop_browse_navigate', { url: FIX + '/open-link' });
  policy.blankLink = brief(await settled('fixture:second'));
  policy.refusedNavigate = await call('desktop_browse_navigate', { url: 'bambustudio://open?model=1' });
  policy.afterRefused = brief(await state());
  policy.fileNavigate = await call('desktop_browse_navigate', { url: 'file:///C:/Windows/win.ini' });
  out.policy = policy;
  phase('idioms');

  // The four download paths. Each is staged, verifiable, and discarded before the next.
  const idioms = {};
  for (const [name, path] of [
    ['anchor', '/blob-anchor'],
    ['href', '/blob-href'],
    ['open', '/blob-open'],
    ['attachment', '/attachment-page'],
  ]) {
    phase('idiom ' + name);
    await call('desktop_browse_navigate', { url: FIX + path });
    const done = await until(async () =>
      (await downloads()).find((d) => d.state === 'completed' && d.isVerifiable) ?? null);
    idioms[name] = done && {
      fileName: done.fileName, received: done.receivedBytes, total: done.totalBytes,
      pageUrl: done.pageUrl, siteId: done.siteId, orphan: done.isOrphan,
    };
    if (done) await call('desktop_browse_discard', { downloadId: done.downloadId });
  }
  out.idioms = idioms;
  out.afterDiscards = await downloads();

  // Landing: a download from a model page, matched to the project that has that page as its
  // website, landed through the loopback API, the staging directory gone afterwards.
  phase('landing');
  const project = await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Landing Project', website: 'https://www.thingiverse.com/thing:7401409' }),
  })).json();
  await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unrelated', website: 'https://www.thingiverse.com/thing:1' }),
  })).json();
  phase('landing: project created');
  await call('desktop_browse_navigate', { url: FIX + '/thing:7401409/dl' });
  phase('landing: navigated');
  const landed = await until(async () =>
    (await downloads()).find((d) => d.state === 'completed' && d.isVerifiable) ?? null);
  out.landed = landed && { fileName: landed.fileName, pageUrl: landed.pageUrl, siteId: landed.siteId };
  phase('landing: landed');
  if (landed) {
    out.match = await call('desktop_browse_match', { url: landed.pageUrl });
    out.matchNone = await call('desktop_browse_match', { url: FIX + '/thing:999' });
    out.matchNull = await call('desktop_browse_match', { url: null });
    phase('landing: matched');
    out.badLand = await call('desktop_browse_land', { downloadId: landed.downloadId, projectId: project.id, name: '../evil.bin' });
    out.unknownLand = await call('desktop_browse_land', { downloadId: 'C:/Windows/win.ini', projectId: project.id, name: null });
    phase('landing: refusals');
    out.land = await call('desktop_browse_land', { downloadId: landed.downloadId, projectId: project.id, name: null });
    phase('landing: landed ok');
    const detail = await (await fetch('/api/projects/' + project.id)).json();
    out.projectAfter = {
      id: detail.id,
      files: (detail.files ?? []).map((f) => ({ name: f.name, sizeBytes: f.sizeBytes })),
    };
    out.downloadsAfterLand = await downloads();
    out.landAgain = await call('desktop_browse_land', { downloadId: landed.downloadId, projectId: project.id, name: null });
  }

  phase('after landing');
  const notices = await call('desktop_browse_notices');
  out.notices = { ok: notices.ok, count: notices.ok ? notices.value.length : -1 };
  // A quiet page to be remembered (the download page would download again when reopened).
  await call('desktop_browse_navigate', { url: FIX + '/second' });
  await settled('fixture:second');
  phase('detaching');
  out.detach = await call('desktop_browse_detach');
  phase('detached');
  out.afterDetach = brief(await state());
  phase('reattaching');
  out.reattach = await call('desktop_browse_attach', {
    bounds: { x: 100, y: 200, width: 700, height: 400 }, url: null,
  });
  phase('reattached');
  out.remembered = brief(await until(async () => {
    const s = await state();
    return s && s.attached && s.url && s.url.startsWith(FIX) && s.title === 'fixture:second' ? s : null;
  }));
  out.detachAgain = await call('desktop_browse_detach');
  out.cleared = await call('desktop_browse_clear_last_page');
  } catch (error) {
    out.crash = String((error && error.stack) || error);
  }
  // A title is a small channel (a long one is cut, and a cut report is not JSON), so the answer
  // goes out in parts, each its own step, with a beat between so none replaces another unread.
  const parts = {
    'browse-a': ['sites', 'attach', 'thing', 'refusedWithNoView', 'badBounds', 'tinyAnswer', 'normalAnswer', 'hide', 'show'],
    'browse-policy': ['policy'],
    'browse-idioms': ['idioms', 'afterDiscards'],
    'browse-landing': ['landed', 'match', 'matchNone', 'matchNull', 'badLand', 'unknownLand', 'land'],
    'browse-project': ['projectAfter', 'downloadsAfterLand', 'landAgain'],
    'browse-end': ['notices', 'detach', 'afterDetach', 'remembered', 'detachAgain', 'cleared', 'crash'],
  };
  for (const [step, keys] of Object.entries(parts)) {
    const part = { step };
    for (const key of keys) part[key] = out[key];
    report(part);
    await sleep(400);
  }
})();
"#;

fn check(report: &mut SmokeReport, name: &str, ok: bool, detail: impl Into<String>) {
    report.checks.push(Check {
        name: name.to_owned(),
        ok,
        detail: detail.into(),
    });
}

/// The bridge half's answer, put back together from the parts the page sent (each is its own
/// step, because a title is a small channel). `None` when the last part never came.
async fn collect_parts(probes: &Probes) -> Option<Value> {
    let mut merged = serde_json::Map::new();
    for step in [
        "browse-a",
        "browse-policy",
        "browse-idioms",
        "browse-landing",
        "browse-project",
        "browse-end",
    ] {
        let part = probes
            .wait_step("main", step, Duration::from_secs(120))
            .await?;
        if let Some(part) = part.as_object() {
            merged.extend(part.clone());
        }
    }
    Some(Value::Object(merged))
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    text.chars().take(600).collect()
}

/// The browse webview's rectangle in logical pixels: `(x, y, width, height)`.
fn view_rect<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64, f64, f64)> {
    let webview = app.get_webview(BROWSE_WEBVIEW)?;
    let rect = webview.bounds().ok()?;
    let scale = webview.window().scale_factor().ok()?;
    let (x, y) = match rect.position {
        Position::Physical(p) => (f64::from(p.x) / scale, f64::from(p.y) / scale),
        Position::Logical(p) => (p.x, p.y),
    };
    let (width, height) = match rect.size {
        Size::Physical(s) => (f64::from(s.width) / scale, f64::from(s.height) / scale),
        Size::Logical(s) => (s.width, s.height),
    };
    Some((x, y, width, height))
}

fn refused(value: &Value) -> bool {
    value["ok"] == false
}

fn ok_value<'a>(report: &'a Value, key: &str) -> Option<&'a Value> {
    (report[key]["ok"] == true).then(|| &report[key]["value"])
}

/// Everything the model browser's smoke run checks. `fixture` is the fixture's origin;
/// `window_for_probe` builds a hidden window on the main webview's data directory at a URL.
pub async fn run<R: Runtime>(
    report: &mut SmokeReport,
    app: &AppHandle<R>,
    main: &WebviewWindow<R>,
    handle: &ServerHandle,
    probes: &Probes,
    fixture: &str,
    open_probe_window: &(dyn Fn(&str, &str) -> bool + Sync),
) {
    let main_origin = format!("http://{}", handle.addr());

    // ----- Part A: through the real bridge -------------------------------------------------------
    note("driving the commands through the bridge");
    let _ = main.eval(BROWSE_MAIN_JS.replace("__FIX__", fixture));

    // Bounds, read off the real child while the page waits for the answer.
    let window_size = {
        let scale = main.scale_factor().unwrap_or(1.0);
        main.inner_size()
            .map(|size| {
                (
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                )
            })
            .unwrap_or((0.0, 0.0))
    };
    let whole = probes
        .wait_step("main", "bounds-whole", STEP_WAIT)
        .await
        .and(view_rect(app));
    note("bounds-whole seen");
    let _ = main.eval("window.__spmGo = 'tiny'");
    probes.wait_step("main", "bounds-tiny", STEP_WAIT).await;
    let tiny = view_rect(app);
    let _ = main.eval("window.__spmGo = 'normal'");
    probes.wait_step("main", "bounds-normal", STEP_WAIT).await;
    let normal = view_rect(app);
    note("bounds done");
    let _ = main.eval("window.__spmGo = 'done'");
    check(
        report,
        "browse: a whole-window request is intersected below the chrome, never over it",
        whole.is_some_and(|(x, y, width, height)| {
            x >= 63.5
                && y >= 99.5
                && x + width <= window_size.0 + 1.0
                && y + height <= window_size.1 + 1.0
                && width > 200.0
                && height > 200.0
        }),
        format!("rect {whole:?} in a window of {window_size:?}"),
    );
    check(
        report,
        "browse: a 1x1 request is not honoured as a rectangle",
        whole.is_some() && tiny == whole,
        format!("before {whole:?}, after {tiny:?}"),
    );
    check(
        report,
        "browse: a real request is positioned by the shell (set_bounds on the child)",
        normal.is_some_and(|(x, y, width, height)| {
            (x - 100.0).abs() < 1.0
                && (y - 200.0).abs() < 1.0
                && (width - 700.0).abs() < 1.0
                && (height - 400.0).abs() < 1.0
        }),
        format!("{normal:?}"),
    );

    let a = collect_parts(probes).await.unwrap_or_else(|| {
        note(&format!(
            "the bridge half did not finish; last report: {}",
            probes.latest("main").map_or("none".into(), |v| v
                .to_string()
                .chars()
                .take(4000)
                .collect::<String>())
        ));
        Value::Null
    });
    note("main part finished");
    check(
        report,
        "browse: the commands reach the view through the real bridge and refuse what they must",
        a["sites"]["count"] == 4
            && a["refusedWithNoView"]["error"]
                .as_str()
                .is_some_and(|error| error.contains("\"code\":\"Conflict\""))
            && a["badBounds"]["error"]
                .as_str()
                .is_some_and(|error| error.contains("\"code\":\"Validation\""))
            && a["attach"]["attached"] == true
            && a["thing"]["siteId"] == "thingiverse"
            && a["thing"]["title"] == "fixture:thing",
        short(&json!({"attach": a["attach"], "thing": a["thing"], "sites": a["sites"]})),
    );
    let policy = &a["policy"];
    check(
        report,
        "browse: the policy is on the view's own webview (a custom scheme, a redirect into one, a file: and an unparseable URL are refused; a redirect to a page is followed)",
        policy["customScheme"]["lastError"]
            .as_str()
            .is_some_and(|sentence| sentence.contains("bambustudio:"))
            && policy["customScheme"]["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/custom-scheme"))
            && policy["redirectCustom"]["lastError"]
                .as_str()
                .is_some_and(|sentence| sentence.contains("bambustudio:"))
            && policy["redirectCustom"]["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/go-redirect-custom"))
            && policy["redirectOk"]["lastError"].is_null()
            && refused(&policy["refusedNavigate"])
            && refused(&policy["fileNavigate"])
            && policy["afterRefused"]["lastError"]
                .as_str()
                .is_some_and(|sentence| sentence.contains("bambustudio:")),
        short(policy),
    );
    check(
        report,
        "browse: a target=_blank link navigates the view itself and opens no window",
        policy["blankLink"]["title"] == "fixture:second"
            && app.webview_windows().keys().all(|label| {
                matches!(
                    label.as_str(),
                    "main" | "probe-same-origin" | "probe-other-port"
                )
            }),
        format!(
            "{} ; windows {:?}",
            short(&policy["blankLink"]),
            app.webview_windows().keys().collect::<Vec<_>>()
        ),
    );
    let idioms = &a["idioms"];
    let staged = |name: &str| {
        idioms[name]["fileName"].is_string()
            && idioms[name]["orphan"] == false
            && idioms[name]["received"].as_i64().unwrap_or(0) > 0
            && idioms[name]["received"] == idioms[name]["total"]
    };
    check(
        report,
        "browse: a blob: download through <a download>, location.href and window.open, and an attachment, are each staged and verifiable",
        ["anchor", "href", "open", "attachment"]
            .iter()
            .all(|name| staged(name))
            && idioms["anchor"]["received"] == 4096
            && idioms["attachment"]["received"] == 2048
            && idioms["anchor"]["fileName"] == "anchor.bin"
            && idioms["attachment"]["fileName"] == "served.bin",
        short(idioms),
    );
    check(
        report,
        "browse: a download is attributed to the page the view was on, not to the blob: URL",
        idioms["anchor"]["pageUrl"]
            .as_str()
            .is_some_and(|url| url.starts_with(fixture) && url.ends_with("/blob-anchor"))
            && idioms["anchor"]["siteId"] == "thingiverse",
        short(&idioms["anchor"]),
    );
    check(
        report,
        "browse: discard removes a staged download",
        a["afterDiscards"].as_array().is_some_and(Vec::is_empty),
        short(&a["afterDiscards"]),
    );
    let project_id = a["projectAfter"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(
        report,
        "browse: a page is matched to the project whose website has its key, and nothing else matches (the honest answer)",
        ok_value(&a, "match").is_some_and(|answer| {
            answer["key"] == "thingiverse:7401409"
                && answer["projects"].as_array().is_some_and(|projects| {
                    projects.len() == 1
                        && projects[0]["name"] == "Landing Project"
                        && projects[0]["id"] == project_id.as_str()
                })
        }) && ok_value(&a, "matchNone")
            .is_some_and(|answer| answer["projects"].as_array().is_some_and(Vec::is_empty))
            && ok_value(&a, "matchNull").is_some_and(|answer| {
                answer["key"].is_null() && answer["projects"].as_array().is_some_and(Vec::is_empty)
            }),
        short(&json!({"match": a["match"], "none": a["matchNone"], "null": a["matchNull"]})),
    );
    check(
        report,
        "browse: landing refuses an unsafe name and an id it never staged, then lands through the loopback API with the bytes in the project and the staging directory gone",
        a["badLand"]["error"]
            .as_str()
            .is_some_and(|e| e.contains("\"code\":\"Validation\""))
            && a["unknownLand"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("\"code\":\"NotFound\""))
            && ok_value(&a, "land")
                .is_some_and(|file| file["kind"] == "other" && file["sizeBytes"] == 4096)
            && a["projectAfter"]["files"]
                .as_array()
                .is_some_and(|files| files.len() == 1 && files[0]["sizeBytes"] == 4096)
            && a["downloadsAfterLand"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && a["landAgain"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("\"code\":\"NotFound\"")),
        short(
            &json!({"land": a["land"], "project": a["projectAfter"]["files"], "after": a["downloadsAfterLand"], "bad": a["badLand"], "unknown": a["unknownLand"]}),
        ),
    );
    check(
        report,
        "browse: detach destroys the view, a second attach remembers the last page, and clearing forgets it",
        ok_value(&a, "detach").is_some()
            && a["afterDetach"]["attached"] == false
            && a["remembered"]["url"]
                .as_str()
                .is_some_and(|url| url.starts_with(fixture))
            && ok_value(&a, "cleared").is_some()
            && app.get_webview(BROWSE_WEBVIEW).is_none(),
        short(&json!({"afterDetach": a["afterDetach"], "remembered": a["remembered"]})),
    );

    note("part B");
    // ----- Part B: from the view's side ----------------------------------------------------------
    let Some(ctx) = app.try_state::<AppCtx>() else {
        return;
    };
    let host = std::sync::Arc::clone(ctx.browse.host());
    let bounds = spm_core::dto::BrowseBounds {
        x: 100.0,
        y: 200.0,
        width: 700.0,
        height: 400.0,
    };
    let hits_before = handle.hits().len();
    let attached = host.attach(
        bounds,
        Some(&format!("{fixture}/bridge?main={main_origin}")),
    );
    let bridge = probes.wait_step("browse", "bridge", STEP_WAIT).await;
    let hits = handle.hits();
    let from_child = hits[hits_before.min(hits.len())..]
        .iter()
        .filter(|hit| hit.path.contains("browse-probe-from-child"))
        .count();
    check(
        report,
        "browse security: an invoke from the browse webview is refused (an app command, a browse command, a plugin command), though the bridge object is there",
        attached.is_ok()
            && bridge.as_ref().is_some_and(|probe| {
                probe["bridge"] == "object"
                    && refused(&probe["library"])
                    && refused(&probe["browse"])
                    && refused(&probe["slicers"])
                    && refused(&probe["plugin"])
                    && refused(&probe["missing"])
            }),
        format!(
            "{attached:?} {}",
            bridge.as_ref().map_or("no answer".into(), short)
        ),
    );
    // The control: the same request from the main webview, with its cookie, is recorded.
    let _ = main.eval("fetch('/api/browse-probe-from-main').catch(() => {})");
    tokio::time::sleep(Duration::from_millis(800)).await;
    let from_main = handle
        .hits()
        .iter()
        .filter(|hit| hit.path.contains("browse-probe-from-main"))
        .count();
    check(
        report,
        "browse security: the loopback API refuses the browse webview (no launch secret, so no request passed the gate), while the main webview's identical request does",
        from_child == 0
            && from_main >= 1
            && bridge.as_ref().is_some_and(|probe| {
                !probe["cookie"]
                    .as_str()
                    .unwrap_or("")
                    .contains("spm_launch")
                    && probe["mainFetch"].as_str().is_some()
            }),
        format!(
            "child requests past the gate {from_child}, main {from_main}; cookie {:?}",
            bridge.as_ref().map(|probe| probe["cookie"].clone())
        ),
    );

    let _ = host.navigate(&format!("{fixture}/geo"));
    let geo = probes.wait_step("browse", "geo", STEP_WAIT).await;
    check(
        report,
        "browse security: a permission request from the browse webview is denied",
        geo.as_ref()
            .is_some_and(|probe| probe["geolocation"] == "error 1"),
        geo.as_ref().map_or("no answer".into(), short),
    );

    // Storage: the browse webview's own profile, in both directions, and persistent.
    let _ = host.navigate(&format!("{fixture}/storage-set"));
    let set = probes.wait_step("browse", "storage-set", STEP_WAIT).await;
    let opened = open_probe_window(
        "probe-storage",
        &format!("{fixture}/storage-get?then=set-side&report=side"),
    );
    let side = probes
        .wait_step("probe-storage", "storage-side", STEP_WAIT)
        .await;
    let _ = host.navigate(&format!("{fixture}/storage-get?report=child"));
    let child = probes.wait_step("browse", "storage-child", STEP_WAIT).await;
    check(
        report,
        "browse security: its storage is isolated from the main webview's profile, both ways (same origin, different data directory)",
        opened
            && set.as_ref().is_some_and(|probe| probe["wrote"] == true)
            && side
                .as_ref()
                .is_some_and(|probe| probe["childCookie"] == false && probe["childLocal"] == false)
            && child.as_ref().is_some_and(|probe| {
                probe["childCookie"] == true
                    && probe["childLocal"] == true
                    && probe["sideCookie"] == false
                    && probe["sideLocal"] == false
            }),
        format!(
            "set {} side {} child {}",
            set.as_ref().map_or("none".into(), short),
            side.as_ref().map_or("none".into(), short),
            child.as_ref().map_or("none".into(), short)
        ),
    );
    if let Some(window) = app.get_webview_window("probe-storage") {
        let _ = window.destroy();
    }

    // The profile is a directory of the app's own, apart from the main webview's.
    let user_data = std::env::var_os(crate::USER_DATA_ENV);
    let profile_ok = user_data.as_deref().is_some_and(|dir| {
        let base = Path::new(dir);
        base.join(crate::browse::BROWSE_PROFILE_DIR).is_dir() && base.join("webview").is_dir()
    });
    check(
        report,
        "browse: the view has a persistent profile directory of its own beside the main webview's",
        profile_ok,
        format!("{user_data:?}"),
    );

    host.detach();
    check(
        report,
        "browse: the view is gone when the route is (no browse webview is left)",
        tokio::time::timeout(Duration::from_secs(5), async {
            while app.get_webview(BROWSE_WEBVIEW).is_some() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .is_ok(),
        "",
    );
}
