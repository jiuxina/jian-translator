/* Source-contract checks for Windows clipboard image packaging; no native API or real clipboard access. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(path.join(root, 'desktop/patch/setup.rs'))).replace(/\r\n/g, '\n');
const readerStart = source.indexOf('fn read_clipboard_content()');
const readerEnd = source.indexOf('\n#[cfg(not(target_os = "windows"))]\nfn read_clipboard_content()', readerStart);
assert.ok(readerStart >= 0 && readerEnd > readerStart, 'The Windows reader is isolated from other platforms');
const reader = source.slice(readerStart, readerEnd);
const layout = source.slice(source.indexOf('fn clipboard_image_layout('), source.indexOf('\nfn clipboard_image_base64('));
const base64 = source.slice(source.indexOf('fn clipboard_image_base64('), source.indexOf('\nfn clipboard_bitmap_file('));
const bitmap = source.slice(source.indexOf('fn clipboard_bitmap_file('), source.indexOf('\nfn clipboard_png_data_url('));
const png = source.slice(source.indexOf('fn clipboard_png_data_url('), source.indexOf('\n#[cfg(target_os = "windows")]\nfn read_open_clipboard_png'));

assert.match(source, /MAX_CLIPBOARD_IMAGE_BYTES:\s*usize\s*=\s*32\s*\*\s*1024\s*\*\s*1024/);
assert.match(layout, /checked_mul\(3\)/);
assert.match(layout, /checked_add\(3\)/, 'DIB row stride is DWORD-aligned using checked arithmetic');
assert.match(layout, /checked_mul\(height as usize\)/);
assert.match(layout, /MAX_CLIPBOARD_IMAGE_DIMENSION/);
assert.match(base64, /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\//);
assert.match(bitmap, /bmp\[\.\.2\]\.copy_from_slice\(b"BM"\)/);
assert.match(bitmap, /54u32\.to_le_bytes\(\)/);
assert.match(bitmap, /24u16\.to_le_bytes\(\)/);
assert.match(bitmap, /\(\-height\)\.to_le_bytes\(\)/, 'Top-down 24-bit BMP header matches GetDIBits output');
assert.match(png, /\\x89PNG\\r\\n\\x1a\\n/);
assert.match(png, /b"IHDR"/);
assert.match(reader, /RegisterClipboardFormatW/);
assert.ok(reader.indexOf('read_open_clipboard_png') < reader.indexOf('read_open_clipboard_bitmap'),
  'PNG is preferred over the synthesized bitmap fallback');
assert.ok(reader.indexOf('read_open_clipboard_bitmap') < reader.indexOf('read_open_clipboard_text'),
  'Image content is preferred over clipboard text');
assert.match(source, /impl Drop for OpenClipboardGuard/);
assert.match(source, /read_clipboard_for_translation\(show_app, id, generation\)/,
  'Reading starts after the WebView receives the begin marker');
console.log('Windows clipboard image source contracts passed; native API behavior still needs a Windows build.');
