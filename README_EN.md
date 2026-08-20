<div align="center">

<img src="brand/logo.svg" width="120" alt="ByePPT logo" />

# ByePPT

**Say goodbye to handcrafted slides** &middot; [中文](./README.md)

<video src="https://github.com/user-attachments/assets/78003634-32e9-4199-a712-ee35f8f71354" title="" aria-label="ByePPT demo" controls muted playsinline></video>

This demo was generated with DeepSeek V4 Flash: 12 slides in 15 minutes, costing just **$0.14**, with a 98% cache hit rate.

</div>

## Highlights

- **Slides from one sentence**: Describe your idea and ByePPT generates the full deck, with live page-by-page previews inside the app.
- **Bring your own models**：Works with multiple model providers and your own API keys.
- **Built on vsurf**：ByePPT integrates [vsurf](https://github.com/warmshao/vsurf), a browser-first RLM agent built on pi. It achieves much higher cache hit rates, so even simpler models perform well, and it can control the browser to research the latest news for your deck.

## Getting started

Download the installer for your platform from [Releases](https://github.com/warmshao/byeppt/releases).

**For macOS users**: the app is currently unsigned. On first launch macOS will say "ByePPT is damaged and can't be opened" — this is just Gatekeeper blocking unsigned apps; the file itself is fine. After dragging the app into Applications, run this once in Terminal:

```bash
xattr -c /Applications/ByePPT.app
```

On macOS versions whose `xattr` supports `-r`, you can also run `xattr -cr /Applications/ByePPT.app` to clear attributes recursively across the `.app` bundle. Older `xattr` versions do not recognize `-r`; use `-c` above instead. The app should then open normally.

## Acknowledgements

- [ppt-master](https://github.com/hugohe3/ppt-master)
- [genoffice](https://github.com/genspark-ai/genoffice)

## License

[AGPL-3.0](./LICENSE)



