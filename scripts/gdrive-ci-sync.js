#!/usr/bin/env node
/**
 * 即庫系統 — GitHub Actions 零相依 Google Drive 自動覆寫同步腳本
 * 使用永久有效的 Google Cloud Service Account JSON 金鑰（或 OAuth Refresh Token JSON）
 * 自動將最新打包之 即庫系統.apk 與 即庫系統.html 原地覆寫至 Google 雲端硬碟「即庫系統」資料夾。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DRIVE_API_BASE = (process.env.GDRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
const FOLDER_ID = (process.env.GDRIVE_FOLDER_ID || '1v9enQ0C-naqv4HCX1zn_p4Wt7NPiOJnd').trim();
const DEFAULT_APK_ID = (process.env.GDRIVE_APK_FILE_ID || '1dZmFn4sKbfw6mg4GbXYtR08YvyjuFIU5').trim();
const DEFAULT_HTML_ID = (process.env.GDRIVE_HTML_FILE_ID || '1y4hkJb9nrZS9nlV6l8wELAlIIUpYiLPV').trim();

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parseCredentials(rawEnv) {
  let text = String(rawEnv || '').trim();
  if (!text) {
    throw new Error('缺少 GDRIVE_SERVICE_ACCOUNT_JSON 環境變數');
  }
  if (!text.startsWith('{')) {
    text = Buffer.from(text, 'base64').toString('utf8').trim();
  }
  const creds = JSON.parse(text);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

async function getAccessToken(creds) {
  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';

  // Mode 1: Google Cloud Service Account JSON (Permanent, never expires)
  if (creds.client_email && creds.private_key) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: tokenUri,
      iat: now,
      exp: now + 3600
    };
    const signingInput = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(payload));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = base64UrlEncode(signer.sign(creds.private_key));
    const jwt = signingInput + '.' + signature;

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }).toString()
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error('Service Account 換取 Google Access Token 失敗: ' + JSON.stringify(data));
    }
    return { accessToken: data.access_token, principal: creds.client_email };
  }

  // Mode 2: OAuth2 Refresh Token JSON fallback
  if (creds.client_id && creds.client_secret && creds.refresh_token) {
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token
      }).toString()
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error('OAuth Refresh Token 換取 Access Token 失敗: ' + JSON.stringify(data));
    }
    return { accessToken: data.access_token, principal: 'OAuth2 Refresh Token' };
  }

  throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON 格式不正確（需包含 client_email 與 private_key）');
}

async function checkFileAccessible(accessToken, fileId, throwOnApiDisabled = false) {
  if (!fileId) return null;
  const url = `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,trashed&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errText = await res.text();
    if (throwOnApiDisabled) {
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return null;
  }
  const info = await res.json();
  if (info.trashed) return null;
  return info;
}

async function findFileInFolderByName(accessToken, folderId, fileName) {
  const escapedName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `'${folderId}' in parents and name = '${escapedName}' and trashed = false`;
  const url =
    `${DRIVE_API_BASE}/drive/v3/files?` +
    new URLSearchParams({
      q,
      fields: 'files(id,name)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

async function updateDriveFileContent(accessToken, fileId, expectedName, currentName, mimeType, fileBuffer) {
  const uploadUrl = `${DRIVE_API_BASE}/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`;
  const res = await fetch(uploadUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mimeType,
      'Content-Length': String(fileBuffer.length)
    },
    body: fileBuffer
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`覆寫檔案 ${expectedName} (${fileId}) 失敗 (HTTP ${res.status}): ${text}`);
  }

  if (currentName && currentName !== expectedName) {
    await fetch(`${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: expectedName })
    });
  }
}

async function createDriveFileInFolder(accessToken, folderId, fileName, mimeType, fileBuffer, principal) {
  const boundary = '-------JikuDriveBoundary' + Date.now();
  const metaJson = JSON.stringify({ name: fileName, parents: [folderId] });
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const ending = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([preamble, fileBuffer, ending]);

  const res = await fetch(`${DRIVE_API_BASE}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes('storageQuotaExceeded')) {
      throw new Error(
        `個人 Google 雲端硬碟不允許服務帳戶 (${principal}) 建立全新擁有者檔案，但可直接覆寫您名下的既有檔案。請確認「即庫系統」資料夾 (${folderId}) 內保留您帳號擁有的「${fileName}」，並已將資料夾共用給 ${principal}（編輯者權限）。`
      );
    }
    throw new Error(`上傳新檔 ${fileName} 至資料夾 ${folderId} 失敗 (HTTP ${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const creds = parseCredentials(process.env.GDRIVE_SERVICE_ACCOUNT_JSON);
  const { accessToken, principal } = await getAccessToken(creds);
  console.log(`✅ 已取得 Google Drive API 授權 (${principal})`);

  let folderInfo = null;
  try {
    folderInfo = await checkFileAccessible(accessToken, FOLDER_ID, true);
  } catch (folderErr) {
    const msg = String(folderErr.message || folderErr);
    if (msg.includes('accessNotConfigured') || msg.includes('has not been used in project')) {
      throw new Error(
        `Google Cloud 專案 (${creds.project_id || 'jiku-sync'}) 尚未啟用 Google Drive API！\n` +
        `請點擊開啟：https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${encodeURIComponent(creds.project_id || 'jiku-sync')} 並按下「啟用 (Enable)」。\n原始回應: ${msg}`
      );
    }
    throw new Error(
      `無法存取 Google 雲端硬碟「即庫系統」資料夾 (ID: ${FOLDER_ID})！\n` +
      `請開啟 https://drive.google.com/drive/folders/${FOLDER_ID} -> 右鍵「共用」-> 新增「${principal}」並設為「編輯者 (Editor)」。\n原始回應: ${msg}`
    );
  }
  if (!folderInfo) {
    throw new Error(`雲端資料夾「即庫系統」(${FOLDER_ID}) 位於垃圾桶中，請先還原。`);
  }

  const targets = [
    {
      name: '即庫系統.apk',
      defaultId: DEFAULT_APK_ID,
      mimeType: 'application/vnd.android.package-archive',
      filePath: path.join(PROJECT_DIR, '即庫系統.apk')
    },
    {
      name: '即庫系統.html',
      defaultId: DEFAULT_HTML_ID,
      mimeType: 'text/html',
      filePath: path.join(PROJECT_DIR, '即庫系統.html')
    }
  ];

  for (const t of targets) {
    if (!fs.existsSync(t.filePath)) {
      throw new Error(`找不到本地打包檔案: ${t.filePath}`);
    }
    const buf = fs.readFileSync(t.filePath);
    const sizeKb = (buf.length / 1024).toFixed(1);

    let existing = await checkFileAccessible(accessToken, t.defaultId);
    if (!existing) {
      existing = await findFileInFolderByName(accessToken, FOLDER_ID, t.name);
    }

    if (existing && existing.id) {
      await updateDriveFileContent(accessToken, existing.id, t.name, existing.name, t.mimeType, buf);
      console.log(`✅ 已原地覆寫雲端硬碟檔案: ${t.name} (${sizeKb} KB) -> https://drive.google.com/file/d/${existing.id}/view`);
    } else {
      const created = await createDriveFileInFolder(accessToken, FOLDER_ID, t.name, t.mimeType, buf, principal);
      console.log(`✅ 已上傳雲端硬碟檔案: ${t.name} (${sizeKb} KB) -> https://drive.google.com/file/d/${created.id}/view`);
    }
  }

  console.log(`🎉 Google 雲端硬碟「即庫系統」資料夾同步完成: https://drive.google.com/drive/folders/${FOLDER_ID}`);
}

main().catch((err) => {
  console.error('❌ Google Drive 自動同步失敗:', err.message || err);
  process.exit(1);
});
