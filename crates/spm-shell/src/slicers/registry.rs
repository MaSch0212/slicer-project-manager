//! The five slicers, as measured: what each is called, how it is found, and what it does to a file
//! it is handed.
//!
//! **Code, not configuration.** Every field is a measured property of the product
//! (`.superpowers/spikes/2026-08-28-slicer-launch-facts.md`) and a user has no business editing any
//! of it: a wrong `exe_name` here is the app spawning something that is not the slicer. What a user
//! *can* configure is which install of a product to launch and where a portable install lives, and
//! that is `slicers.json` ([`crate::slicers::config`]); nothing in this file is in it.
//!
//! **There is deliberately no strip field.** The strip sets are indexed by the flavour of the
//! *file*, not by the slicer being launched, and live in `spm_core::files::strip3mf`.

use spm_core::dto::SlicerId;

/// How detection finds a product on Windows.
#[derive(Debug, Clone, Copy)]
pub struct WindowsDetection {
    /// Matched against an uninstall key's `DisplayName` case-insensitively, anchored at the start
    /// and required to end at a word boundary: `PrusaSlicer` claims `PrusaSlicer 2.9.6` and not a
    /// hypothetical `PrusaSlicerXL`.
    pub display_name_prefix: &'static str,
    /// The basename `DisplayIcon` must resolve to. Validation, not search: it is what stops
    /// `CuraEngine.exe`, `prusa-gcodeviewer.exe`, `prusa-slicer-console.exe` or an uninstaller
    /// (all measured) being taken for the slicer.
    pub exe_name: &'static str,
    /// Set only for MSIX products (Orca). The family and not the full name: the full name embeds
    /// the version and changes on every update.
    pub msix_package_family: Option<&'static str>,
}

/// What this slicer does to a file it is handed, as measured. Never a strip set.
#[derive(Debug, Clone, Copy)]
pub struct SlicerBehaviour {
    /// Whether Ctrl+S writes back over the file that was opened. False for Cura alone.
    pub saves_in_place: bool,
    /// Whether an unstripped foreign project is silently discarded (Anycubic).
    pub discards_foreign_projects: bool,
    /// Whether a `.3mf` always draws a modal regardless of content (PrusaSlicer).
    pub always_prompts_on_3mf: bool,
    /// Whether a modal fires on the *absence* of its own config (Bambu).
    pub prompts_without_own_config: bool,
    /// Whether the product reads a `.step` or a `.stp` at all. False for Cura alone, and the one
    /// flag here that stops a launch rather than phrasing a sentence about one. It is one boolean
    /// because exactly one measurement distinguishes exactly one product; it must not grow into a
    /// capability matrix.
    pub opens_step: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SlicerDef {
    pub id: SlicerId,
    pub display_name: &'static str,
    pub windows: WindowsDetection,
    pub behaviour: SlicerBehaviour,
}

impl SlicerDef {
    /// argv for a file: `[file]` for all five. A method so that a sixth need not be.
    pub fn argv(&self, file: &str) -> Vec<String> {
        vec![file.to_owned()]
    }
}

/// Every product, in the order `/settings/slicers` lists them.
pub const SLICER_IDS: [SlicerId; 5] = [
    SlicerId::Cura,
    SlicerId::Prusaslicer,
    SlicerId::Anycubic,
    SlicerId::Bambu,
    SlicerId::Orca,
];

const CURA: SlicerDef = SlicerDef {
    id: SlicerId::Cura,
    display_name: "UltiMaker Cura",
    windows: WindowsDetection {
        display_name_prefix: "UltiMaker Cura",
        exe_name: "UltiMaker-Cura.exe",
        msix_package_family: None,
    },
    behaviour: SlicerBehaviour {
        saves_in_place: false,
        discards_foreign_projects: false,
        always_prompts_on_3mf: false,
        prompts_without_own_config: false,
        opens_step: false,
    },
};

const PRUSASLICER: SlicerDef = SlicerDef {
    id: SlicerId::Prusaslicer,
    display_name: "PrusaSlicer",
    windows: WindowsDetection {
        display_name_prefix: "PrusaSlicer",
        exe_name: "prusa-slicer.exe",
        msix_package_family: None,
    },
    behaviour: SlicerBehaviour {
        saves_in_place: true,
        discards_foreign_projects: false,
        always_prompts_on_3mf: true,
        prompts_without_own_config: false,
        opens_step: true,
    },
};

const ANYCUBIC: SlicerDef = SlicerDef {
    id: SlicerId::Anycubic,
    display_name: "Anycubic Slicer Next",
    windows: WindowsDetection {
        display_name_prefix: "AnycubicSlicerNext",
        exe_name: "AnycubicSlicerNext.exe",
        msix_package_family: None,
    },
    behaviour: SlicerBehaviour {
        saves_in_place: true,
        discards_foreign_projects: true,
        always_prompts_on_3mf: false,
        prompts_without_own_config: false,
        opens_step: true,
    },
};

const BAMBU: SlicerDef = SlicerDef {
    id: SlicerId::Bambu,
    display_name: "Bambu Studio",
    windows: WindowsDetection {
        display_name_prefix: "Bambu Studio",
        exe_name: "bambu-studio.exe",
        msix_package_family: None,
    },
    behaviour: SlicerBehaviour {
        saves_in_place: true,
        discards_foreign_projects: false,
        always_prompts_on_3mf: false,
        prompts_without_own_config: true,
        opens_step: true,
    },
};

const ORCA: SlicerDef = SlicerDef {
    id: SlicerId::Orca,
    display_name: "OrcaSlicer",
    windows: WindowsDetection {
        display_name_prefix: "OrcaSlicer",
        exe_name: "orca-slicer.exe",
        msix_package_family: Some("OrcaSlicer.OrcaSlicer_3qd7h69xpne0g"),
    },
    behaviour: SlicerBehaviour {
        saves_in_place: true,
        discards_foreign_projects: false,
        always_prompts_on_3mf: false,
        prompts_without_own_config: false,
        opens_step: true,
    },
};

/// The registry row for a product. Total: a sixth `SlicerId` fails to compile here until it has one.
pub fn slicer(id: SlicerId) -> &'static SlicerDef {
    match id {
        SlicerId::Cura => &CURA,
        SlicerId::Prusaslicer => &PRUSASLICER,
        SlicerId::Anycubic => &ANYCUBIC,
        SlicerId::Bambu => &BAMBU,
        SlicerId::Orca => &ORCA,
    }
}

/// Whether `display_name` is claimed by `prefix`: starts with it (case-insensitively) and ends at a
/// word boundary, which is what `^Prefix\b` meant.
pub fn display_name_matches(display_name: &str, prefix: &str) -> bool {
    let name: Vec<char> = display_name.chars().collect();
    let want: Vec<char> = prefix.chars().collect();
    if name.len() < want.len() {
        return false;
    }
    let same = name
        .iter()
        .zip(&want)
        .all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()));
    if !same {
        return false;
    }
    match name.get(want.len()) {
        None => true,
        Some(next) => !(next.is_ascii_alphanumeric() || *next == '_'),
    }
}

/// The product whose row claims this uninstall key's `DisplayName`, or `None`.
pub fn slicer_for_display_name(display_name: &str) -> Option<SlicerId> {
    SLICER_IDS
        .into_iter()
        .find(|id| display_name_matches(display_name, slicer(*id).windows.display_name_prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_and_the_table_agree() {
        for id in SLICER_IDS {
            assert_eq!(slicer(id).id, id);
        }
        // Only Cura cannot read STEP and only Cura does not save in place: two measured facts that
        // happen to be about the same product, and nothing else in the table is.
        for id in SLICER_IDS {
            let cura = id == SlicerId::Cura;
            assert_eq!(slicer(id).behaviour.opens_step, !cura);
            assert_eq!(slicer(id).behaviour.saves_in_place, !cura);
        }
        assert_eq!(
            SLICER_IDS
                .into_iter()
                .filter(|id| slicer(*id).behaviour.opens_step)
                .count(),
            4
        );
    }

    #[test]
    fn a_display_name_must_end_at_a_word_boundary() {
        assert!(display_name_matches("PrusaSlicer", "PrusaSlicer"));
        assert!(display_name_matches("PrusaSlicer 2.9.6", "PrusaSlicer"));
        assert!(display_name_matches("prusaslicer", "PrusaSlicer"));
        assert!(!display_name_matches("PrusaSlicerXL", "PrusaSlicer"));
        assert!(!display_name_matches("My PrusaSlicer", "PrusaSlicer"));
        assert!(!display_name_matches("Prusa", "PrusaSlicer"));
        assert_eq!(
            slicer_for_display_name("UltiMaker Cura 5.12.0"),
            Some(SlicerId::Cura)
        );
        assert_eq!(slicer_for_display_name("Fork"), None);
    }
}
