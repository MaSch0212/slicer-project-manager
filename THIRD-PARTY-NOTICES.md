# Third-party notices

Slicer Project Manager is distributed under the MIT licence in `LICENSE`. It also carries software
written by other people under other licences, and this file is the notice those licences ask for.

Everything below is a statement about files: which package, which version, which licence text, and
where that text is on disk in a build of this application. Nothing here is legal advice, and none
is implied.

## occt-import-js 0.0.23 — LGPL-2.1

- **Package:** [`occt-import-js`](https://github.com/kovacsv/occt-import-js), version `0.0.23`, by
  Viktor Kovács.
- **Licence:** LGPL-2.1, as declared by the package's own `package.json`.
- **Dependencies:** none. It is one npm package and nothing else comes with it.
- **What this application uses it for:** reading STEP (`.step`, `.stp`) files and turning them into
  triangle meshes, so that a STEP file in a library gets a thumbnail. `packages/core` calls exactly
  one of its entry points, `ReadStepFile`.

`occt-import-js` is a WebAssembly build of **Open CASCADE Technology (OCCT)**, the CAD kernel that
does the actual reading. OCCT is a separate work by Open CASCADE S.A.S., also under LGPL-2.1, and
it ships inside `occt-import-js.wasm` rather than as a package of its own.

### Where the licence texts are

The upstream package ships three licence files. Two of them are byte-identical:
`LICENSE.md` and `dist/license.occt-import-js.txt` have the same SHA-256
(`7ffe1954587c77dfba1cf8eb9b2ea743671fa6e63f9e7a2f258119d42e14eefe`), so this application stages one
copy of that text rather than two. `dist/license.occt.txt` is a distinct file and is staged as well.

| Upstream file                                      | Staged into a build as              | Covers                  |
| -------------------------------------------------- | ----------------------------------- | ----------------------- |
| `LICENSE.md` (= `dist/license.occt-import-js.txt`) | `dist/third-party/LICENSE.md`       | `occt-import-js` itself |
| `dist/license.occt.txt`                            | `dist/third-party/license.occt.txt` | Open CASCADE Technology |

`packages/desktop/build.ts` copies them there, and `requiredArtifacts()` in
`packages/desktop/packaging.ts` names them, so `deno task package:desktop` fails rather than
shipping an application that is missing one. This file is staged beside them, as
`dist/third-party/THIRD-PARTY-NOTICES.md`. In an installed application those paths are under
`resources/app/`.

Both texts are LGPL-2.1. The two differ only in whitespace — the OCCT copy indents with tabs where
the other uses spaces, and wraps two lines differently — and are otherwise the same document.

### What §6 of the shipped text says, and how this application meets it

Recorded here because it is the clause that decides what shipping a compiled copy of the library
costs, and because reading it is cheaper than assuming it.

Section 6 of the shipped `dist/license.occt.txt` is the standard LGPL-2.1 section 6. It **permits**
combining or linking a "work that uses the Library" with the Library and distributing the result
under terms of your choice — provided those terms permit modification for the customer's own use
and reverse engineering for debugging such modifications — and then requires prominent notice, a
copy of the licence, and one of the options 6a to 6e.

There is no additional Open CASCADE static-linking exception in the shipped text. The word
"exception" occurs three times in it, and each is part of LGPL-2.1's own wording: section 6's own
opening clause, the special exception about the required form of an executable further down section
6, and section 11's note about the Free Software Foundation. An extra exception could only loosen
what follows, and what follows is met without one.

- **The notice** is this file, staged into every build.
- **A copy of the licence** is the two texts in the table above, staged beside it.
- **Option 6b** — "use a suitable shared library mechanism", one that uses a copy of the library at
  run time and "will operate properly with a modified version of the library, if the user installs
  one" — is what this application does. The library is not linked into the main bundle: it is
  `occt-import-js.wasm`, a loose file in `dist/`, read at call time. Replacing that file with
  another build of `occt-import-js` is enough to change which library the application runs. The
  packaged application stores `resources/app` as a plain directory tree, so the file is an ordinary
  file on disk there too, and `requiredArtifacts()` asserts it is present.
- **The library is unmodified.** The `.wasm` is copied byte for byte out of the installed package
  by `copyWasm()` in `packages/desktop/build.ts`. Nothing in this repository patches, rebuilds or
  post-processes it, and the JavaScript glue is bundled as published.

If `packages/desktop/package-app.ts` is ever changed to pass `asar: true`, the `.wasm` and the
licence texts would need naming in `asarUnpack` for the paragraph above to stay true. It passes
`asar: false` today.

### Corresponding source

The source for `occt-import-js@0.0.23`, including the OCCT sources it is built from, is published at
<https://github.com/kovacsv/occt-import-js> and in the npm tarball this application resolves the
`.wasm` out of — the package ships its own C++ sources and build files.
