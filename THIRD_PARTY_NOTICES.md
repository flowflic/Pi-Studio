# Third-party notices

Pi Studio includes pricing catalogs, billing math and quota response parsers adapted from [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter), commit `c9885ddf2f1b09260a1166bac943d30e1121cbae` (2026-09-30 snapshot), under the MIT License. Copyright (c) 2026 dsh-cost-meter contributors. The full license is retained in `src/main/vendor/dsh-cost-meter-LICENSE` and distributed under `resources/licenses/`. Adaptation details are in `src/main/vendor/README.md`.

Pi Studio is distributed under the MIT License for the Pi Studio code only. This file records the major components used by the source tree and the packaged application. Third-party software remains under its own license.

When redistributing a built application, keep this notice together with the application and retain the license and copyright files shipped with the bundled dependencies.

## Bundled runtime

### Pi coding agent

- Package: `@earendil-works/pi-coding-agent`
- Version in the current embedded runtime: `0.99.1`
- License: MIT
- Copyright: Mario Zechner
- Source: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- License text: <https://github.com/earendil-works/pi/blob/main/LICENSE>

Pi Studio launches the Pi coding agent as a bundled runtime. Pi's own source, trademarks, and dependencies are not relicensed by Pi Studio.

### Node.js

- Runtime in the current embedded package: Node.js `v24.14.0`
- License and attribution: <https://github.com/nodejs/node/blob/v24.14.0/LICENSE>
- Project: <https://nodejs.org/>

The Node.js license file contains the notices for Node.js and the externally maintained libraries included by Node.js.

## Application dependencies

The following versions are the resolved package versions used when this notice was generated.

| Package | Version | License |
| --- | ---: | --- |
| `clsx` | 2.1.1 | MIT |
| `highlight.js` | 11.11.1 | BSD-3-Clause |
| `jszip` | 3.10.1 | MIT or GPL-3.0-or-later |
| `docx-preview` | 0.3.7 | Apache-2.0 |
| `@univerjs/presets`, `@univerjs/preset-sheets-core` and Univer modules | 1.0.3 | Apache-2.0 |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `react-markdown` | 9.1.0 | MIT |
| `rehype-highlight` | 7.0.2 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `xlsx` | 0.18.5 | Apache-2.0 |
| `zustand` | 4.5.7 | MIT |

Build-time packages are listed separately because they are used to create the application rather than as application features:

| Package | Version | License |
| --- | ---: | --- |
| `@types/node` | 22.20.1 | MIT |
| `@types/react` | 18.3.31 | MIT |
| `@types/react-dom` | 18.3.7 | MIT |
| `@vitejs/plugin-react` | 4.7.0 | MIT |
| `electron` | 33.4.11 | MIT, plus Chromium and other notices |
| `electron-builder` | 25.1.8 | MIT |
| `electron-vite` | 2.3.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 5.4.21 | MIT |

## Transitive dependencies

The Pi runtime and the Electron application include transitive npm dependencies. Their package manifests and license files are retained in the generated runtime tree where applicable. The authoritative inventories are:

- `package-lock.json` for the Pi Studio source dependencies.
- The generated runtime manifest and embedded runtime archive for the Pi runtime.
- The license files distributed beside the corresponding packages in the packaged application.

Common license families in the bundled Pi runtime include MIT, Apache-2.0, BSD-3-Clause, BlueOak-1.0.0, ISC, and 0BSD. Each dependency's own license terms take precedence over this summary.

## Electron and Chromium notices

Electron distributions contain Chromium, Node.js, and additional third-party components. Electron's release-specific notices are available from the Electron project:

- <https://github.com/electron/electron/blob/v33.4.11/LICENSE>
- <https://github.com/electron/electron/tree/v33.4.11>

## Trademark note

Pi, Node.js, Electron, React, and the names and logos of the packages listed above are trademarks or marks of their respective owners. This project is not an endorsement or official distribution of those projects.
