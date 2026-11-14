package com.visionpos.edge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Lightweight zero-dependency ContentProvider serving temporary camera photos
 * and exported CSV/JSON files safely via content://com.visionpos.edge.capture/...
 */
public class CaptureFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.visionpos.edge.capture";

    public static Uri buildUriForFile(String subDir, String fileName) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(subDir)
                .appendPath(fileName)
                .build();
    }

    private File resolveTargetFile(Uri uri) throws FileNotFoundException {
        if (getContext() == null || uri == null) {
            throw new FileNotFoundException("Invalid context or URI");
        }
        java.util.List<String> segs = uri.getPathSegments();
        if (segs == null || segs.size() < 2) {
            throw new FileNotFoundException("Invalid URI segments: " + uri);
        }
        String subDir = segs.get(0).replaceAll("[^a-zA-Z0-9_-]", "");
        String name = new File(segs.get(1)).getName();
        File baseDir = new File(getContext().getCacheDir(), subDir);
        if (!baseDir.exists()) {
            baseDir.mkdirs();
        }
        return new File(baseDir, name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolveTargetFile(uri);
        int imode = ParcelFileDescriptor.MODE_READ_ONLY;
        if ("w".equals(mode) || "wt".equals(mode)) {
            imode = ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        } else if ("rw".equals(mode) || "rwt".equals(mode)) {
            imode = ParcelFileDescriptor.MODE_READ_WRITE
                    | ParcelFileDescriptor.MODE_CREATE;
        }
        return ParcelFileDescriptor.open(file, imode);
    }

    @Override
    public String getType(Uri uri) {
        String path = uri.getLastPathSegment();
        if (path != null) {
            int dot = path.lastIndexOf('.');
            if (dot >= 0) {
                String ext = path.substring(dot + 1).toLowerCase();
                if ("csv".equals(ext)) return "text/csv";
                if ("json".equals(ext)) return "application/json";
                if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
                String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                if (mime != null) return mime;
            }
        }
        return "application/octet-stream";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = resolveTargetFile(uri);
            String[] cols = projection != null
                    ? projection
                    : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
            MatrixCursor cursor = new MatrixCursor(cols, 1);
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                    row[i] = file.getName();
                } else if (OpenableColumns.SIZE.equals(cols[i])) {
                    row[i] = file.exists() ? file.length() : 0L;
                }
            }
            cursor.addRow(row);
            return cursor;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        try {
            File file = resolveTargetFile(uri);
            return file.delete() ? 1 : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
