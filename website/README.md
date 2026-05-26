# Daio site

Static single-file site at `index.html`. No build step.

## Preview locally

```bash
python3 -m http.server 8080 --directory .
# then open http://localhost:8080
```

Or any other static server (`npx serve`, `caddy file-server`, etc).

## Design

Brutalist-technical. Dark background, JetBrains Mono throughout, lime accent (`#d0ff00`), 1px hard borders, no images.

Sections: hero, quickstart, protocol, agents, deploy, roadmap, resources.

All CSS is embedded in `index.html` for portability. To swap accent or palette, edit the `:root` block at the top of the `<style>` element.

## Deploy

Static hosting works as-is. Vercel, Netlify, GitHub Pages, Cloudflare Pages all auto-detect.
