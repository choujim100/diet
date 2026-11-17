Text recognition (OCR) for the "Scan nutrition label" feature, bundled so the label photo never leaves the device.

- tesseract.min.js, worker.min.js: tesseract.js 7.0.0 (Apache-2.0), https://github.com/naptha/tesseract.js
- core/*.wasm.js: tesseract.js-core 7.0.0, Tesseract compiled to WebAssembly (Apache-2.0)
- lang/swe.traineddata.gz, lang/eng.traineddata.gz: Tesseract "best" models, integer version (Apache-2.0), via @tesseract.js-data/swe and /eng 1.0.0

Licence texts: LICENSE-tesseract.js.txt, LICENSE-tesseract.js-core.txt. Loaded only when the user taps "Scan nutrition label".
