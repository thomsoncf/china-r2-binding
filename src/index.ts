export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// GET / — serve the upload frontend
		if (url.pathname === '/' && request.method === 'GET') {
			return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
		}

		// POST /upload — stream file directly into R2
		if (url.pathname === '/upload' && request.method === 'POST') {
			const filename = request.headers.get('X-Filename');
			if (!filename || !request.body) {
				return Response.json({ error: 'No file provided' }, { status: 400 });
			}

			const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
			const size = Number(request.headers.get('Content-Length') || 0);

			await env.R2_BUCKET.put(filename, request.body, {
				httpMetadata: { contentType },
			});

			const fileUrl = new URL(`/files/${encodeURIComponent(filename)}`, url.origin).toString();

			return Response.json({ key: filename, url: fileUrl, size });
		}

		// GET /files — list all objects in the bucket
		if (url.pathname === '/files' && request.method === 'GET') {
			const listed = await env.R2_BUCKET.list({ limit: 1000 });
			const files = listed.objects.map((obj) => ({
				key: obj.key,
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
			}));
			return Response.json(files);
		}

		// GET /files/:key — serve a file from R2
		if (url.pathname.startsWith('/files/') && request.method === 'GET') {
			const key = decodeURIComponent(url.pathname.slice('/files/'.length));
			const object = await env.R2_BUCKET.get(key);
			if (!object) {
				return new Response('Not found', { status: 404 });
			}

			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			return new Response(object.body, { headers });
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>R2 File Upload</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
  .drop-zone { border: 2px dashed #ccc; border-radius: 8px; padding: 2rem; text-align: center; cursor: pointer; transition: border-color .2s, background .2s; margin-bottom: 1rem; }
  .drop-zone.dragover { border-color: #2563eb; background: #eff6ff; }
  .drop-zone input { display: none; }
  button { background: #2563eb; color: #fff; border: none; padding: .5rem 1.25rem; border-radius: 6px; cursor: pointer; font-size: .9rem; }
  button:disabled { opacity: .5; cursor: default; }
  #result { margin: 1rem 0; padding: 1rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; display: none; word-break: break-all; }
  #result.error { background: #fef2f2; border-color: #fecaca; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; font-size: .85rem; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #e5e7eb; }
  th { background: #f9fafb; font-weight: 600; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #6b7280; font-size: .85rem; }
  .progress-wrap { display: none; margin: 1rem 0; }
  .progress-bar { background: #e5e7eb; border-radius: 6px; height: 1.25rem; overflow: hidden; position: relative; }
  .progress-fill { background: #2563eb; height: 100%; width: 0%; transition: width .15s; }
  .progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: .75rem; font-weight: 600; color: #1a1a1a; }
  .progress-meta { margin-top: .35rem; font-size: .8rem; color: #6b7280; }
</style>
</head>
<body>
<h1>R2 File Upload</h1>

<div class="drop-zone" id="dropZone">
  <p>Drag &amp; drop a file here, or click to select</p>
  <input type="file" id="fileInput">
</div>
<button id="uploadBtn" disabled>Upload</button>

<div class="progress-wrap" id="progressWrap">
  <div class="progress-bar"><div class="progress-fill" id="progressFill"></div><div class="progress-text" id="progressText">0%</div></div>
  <div class="progress-meta" id="progressMeta"></div>
</div>

<div id="result"></div>

<h2 style="font-size:1.1rem;margin-top:2rem;">Uploaded Files</h2>
<table>
  <thead><tr><th>Name</th><th>Size</th><th>Uploaded</th></tr></thead>
  <tbody id="fileList"><tr><td colspan="3" class="meta">Loading...</td></tr></tbody>
</table>

<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const resultDiv = document.getElementById('result');
let selectedFile = null;

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) pickFile(fileInput.files[0]); });

function pickFile(f) {
  selectedFile = f;
  dropZone.querySelector('p').textContent = f.name + ' (' + formatSize(f.size) + ')';
  uploadBtn.disabled = false;
}

const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressMeta = document.getElementById('progressMeta');

uploadBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  uploadBtn.disabled = true;
  resultDiv.style.display = 'none';
  resultDiv.className = '';
  progressWrap.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressMeta.textContent = '';

  const totalSize = selectedFile.size;
  const start = performance.now();

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.setRequestHeader('X-Filename', selectedFile.name);
  xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    progressFill.style.width = pct + '%';
    progressText.textContent = pct + '%';
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed > 0) {
      const speed = e.loaded / elapsed;
      progressMeta.textContent = formatSize(e.loaded) + ' / ' + formatSize(e.total) + ' \\u00b7 ' + formatSize(speed) + '/s';
    }
  };

  xhr.onload = () => {
    const elapsed = (performance.now() - start) / 1000;
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status >= 400) throw new Error(data.error || 'Upload failed');
      const speed = data.size / elapsed;
      resultDiv.innerHTML =
        '<strong>Uploaded successfully</strong><br>' +
        'File URL: <a href="' + data.url + '" target="_blank">' + data.url + '</a><br>' +
        '<span class="meta">Size: ' + formatSize(data.size) + ' \\u00b7 Time: ' + elapsed.toFixed(2) + 's \\u00b7 Speed: ' + formatSize(speed) + '/s</span>';
      resultDiv.style.display = 'block';
      loadFiles();
    } catch (err) {
      resultDiv.textContent = 'Error: ' + err.message;
      resultDiv.className = 'error';
      resultDiv.style.display = 'block';
    }
    uploadBtn.disabled = false;
  };

  xhr.onerror = () => {
    resultDiv.textContent = 'Error: Network error';
    resultDiv.className = 'error';
    resultDiv.style.display = 'block';
    uploadBtn.disabled = false;
  };

  xhr.send(selectedFile);
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

async function loadFiles() {
  const tbody = document.getElementById('fileList');
  try {
    const res = await fetch('/files');
    const files = await res.json();
    if (!files.length) { tbody.innerHTML = '<tr><td colspan="3" class="meta">No files yet</td></tr>'; return; }
    tbody.innerHTML = files.map(f =>
      '<tr><td><a href="/files/' + encodeURIComponent(f.key) + '" target="_blank">' + esc(f.key) + '</a></td>' +
      '<td>' + formatSize(f.size) + '</td>' +
      '<td class="meta">' + new Date(f.uploaded).toLocaleString() + '</td></tr>'
    ).join('');
  } catch { tbody.innerHTML = '<tr><td colspan="3" class="meta">Failed to load files</td></tr>'; }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

loadFiles();
</script>
</body>
</html>`;
