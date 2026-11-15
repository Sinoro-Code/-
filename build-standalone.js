#!/usr/bin/env node
/**
 * 即庫系統 — Universal Standalone Mobile/Android HTML Bundler
 * Bundles index.html + styles.css + vision-engine.js + app.js into 即庫系統.html
 * with safe CSS/JS comment & whitespace compaction and VM syntax verification.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectDir = __dirname;
const pubDir = path.join(projectDir, 'public');
const outPath = path.join(projectDir, '即庫系統.html');
const legacyOutPath = path.join(projectDir, 'VisionPOS-Android.html');

function compactCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\s*([{}:;,>~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function compactJsSafe(js, label) {
  // Verify original syntax first
  new vm.Script(js, { filename: label });

  // Strip standalone JSDoc / block comment headers and pure full-line // comments + blank lines
  const compacted = js
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('//')) return false;
      return true;
    })
    .join('\n');

  // Verify compacted syntax via V8 parser; fallback to original if anything fails
  try {
    new vm.Script(compacted, { filename: label + '.min' });
    return compacted;
  } catch (_) {
    return js;
  }
}

let html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
const rawCss = fs.readFileSync(path.join(pubDir, 'css/styles.css'), 'utf8');
const rawEngine = fs.readFileSync(path.join(pubDir, 'js/vision-engine.js'), 'utf8');
const rawApp = fs.readFileSync(path.join(pubDir, 'js/app.js'), 'utf8');

const minCss = compactCss(rawCss);
const minEngine = compactJsSafe(rawEngine, 'vision-engine.js');
const minApp = compactJsSafe(rawApp, 'app.js');

html = html.replace(/<link rel="icon" href="\/icon\.svg(?:\?[^"]*)?" type="image\/svg\+xml" \/>/, '');
html = html.replace(/<link rel="manifest" href="\/manifest\.json(?:\?[^"]*)?" \/>/, '');
html = html.replace(/<link rel="stylesheet" href="\/css\/styles\.css(?:\?[^"]*)?" \/>/, () => '<style>\n' + minCss + '\n</style>');
html = html.replace(/<script src="\/js\/vision-engine\.js(?:\?[^"]*)?"><\/script>/, () => '<script>\n' + minEngine + '\n</script>');
html = html.replace(/<script src="\/js\/app\.js(?:\?[^"]*)?"><\/script>/, () => '<script>\n' + minApp + '\n</script>');
html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{2,}/g, '\n');

if (fs.existsSync(legacyOutPath)) {
  fs.unlinkSync(legacyOutPath);
}
fs.writeFileSync(outPath, html, 'utf8');
const sizeBytes = Buffer.byteLength(html, 'utf8');
console.log(`  -> 已生成全安卓通用單檔版 即庫系統.html (${sizeBytes} bytes / ${(sizeBytes / 1024).toFixed(1)} KB)`);
