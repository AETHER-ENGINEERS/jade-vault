# Jade Vault: browser version

`index.html` is the whole app in one file. Serve it from any static host (GitHub Pages, Netlify, `python3 -m http.server`).
Notes, memory and settings are stored in your browser (IndexedDB / localStorage). Nothing is uploaded anywhere
except the model requests you configure (Ollama local or cloud, Groq, OpenAI-compatible).
Rebuild with `npm run build` and copy `android/proj/assets/index.html` to `docs/index.html`.
