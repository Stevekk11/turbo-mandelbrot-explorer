# turbo-mandelbrot-explorer

Rychlý interaktivní prohlížeč fraktálů postavený v TypeScriptu a WASM. Zobrazuje Mandelbrotovu i Multibrotovu množinu a je navržený tak, aby zvládl plynulý pohyb i hluboký zoom.

Kromě základního mandelbrotu umí také Julia set, Burning Ship a Tricorn. Nechybí barevné palety, animace barev a další vizuální efekty.

## Spuštění

```bash
npm install
npm run dev
```

Pro produkční build:

```bash
npm run build
```

Demo: https://stevekk11.github.io/turbo-mandelbrot-explorer/

Pozor: aplikace používá dynamické a někdy blikající barvy.