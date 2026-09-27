# Third-party code, served from this site

Kept here rather than loaded from a CDN, so no outside server ever runs code on
the page that holds your portfolio or reads your statement PDF.

| Folder    | Library   | Version  | From                                      | Licence    |
|-----------|-----------|----------|-------------------------------------------|------------|
| `chartjs` | Chart.js  | 4.4.1    | npm `chart.js`, `dist/chart.umd.js`       | MIT        |
| `pdfjs`   | PDF.js    | 5.4.624  | npm `pdfjs-dist`, `legacy/build/*.min.mjs` (renamed `.js`) | Apache-2.0 |

The `.mjs` files are renamed `.js` so every web server sends them as JavaScript,
which module scripts need. To update, replace the files with the same ones from
the new version and change the table.
