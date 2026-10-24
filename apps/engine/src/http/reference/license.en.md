---
slug: license
summary: Under which license you may use and share SubKit.
section: reference
order: 4
audience: public
---
## License

MIT


## Third-party components

Every release ships `THIRD_PARTY_NOTICES.txt` next to the binaries. It lists the license
texts of all bundled packages, the embedded embedding model and the Bun runtime.

- **Embedding model:** `paraphrase-multilingual-MiniLM-L12-v2` by sentence-transformers,
  Apache-2.0 per the upstream Hugging Face model card; ONNX conversion by Xenova.
- **Bun runtime:** the `engine` and `sk` executables contain the Bun runtime, which statically
  links LGPL components (JavaScriptCore/WebKit, tinycc). The section "Relinking and
  corresponding source" in `THIRD_PARTY_NOTICES.txt` explains how to rebuild and relink.
- **Container image:** `/usr/local/share/subkit/` also holds `BASE_IMAGE_INVENTORY.txt`
  (operating system packages and browser builds of the base image) and `SOURCE_OFFER.txt`.

The corresponding source of the GPL and LGPL components is available on request for at least
three years (written offer in the notices). Once the SubKit repository is public, it will also
be linked there.
