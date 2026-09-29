package com.farrapy.openanimator;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Lets other apps read a file of the data folder when the user shares it or opens it
 * ("Compartir", "Abrir con…"). Read-only, not exported: access only through the
 * temporary permission that goes with each share intent.
 *
 *   content://com.farrapy.openanimator.files/d/<path inside data>?name=<display name>
 */
public final class SharedFileProvider extends ContentProvider {
    static final String AUTHORITY = BuildInfo.APPLICATION_ID + ".files";

    static Uri uriFor(Context c, String relPath, String displayName) {
        Uri.Builder b = new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("d");
        for (String part : relPath.split("/")) if (!part.isEmpty()) b.appendPath(part);
        if (displayName != null && !displayName.isEmpty()) b.appendQueryParameter("name", displayName);
        return b.build();
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        java.util.List<String> seg = uri.getPathSegments();
        if (seg.size() < 2 || !seg.get(0).equals("d")) throw new FileNotFoundException(uri.toString());
        StringBuilder rel = new StringBuilder();
        for (int i = 1; i < seg.size(); i++) {
            if (seg.get(i).equals("..")) throw new FileNotFoundException(uri.toString());
            if (rel.length() > 0) rel.append('/');
            rel.append(seg.get(i));
        }
        try {
            File root = new File(getContext().getFilesDir(), "data").getCanonicalFile();
            File f = new File(root, rel.toString()).getCanonicalFile();
            if (!f.getPath().startsWith(root.getPath() + File.separator) || !f.isFile()) throw new FileNotFoundException(uri.toString());
            return f;
        } catch (IOException e) {
            throw new FileNotFoundException(uri.toString());
        }
    }

    private static String nameOf(Uri uri, File f) {
        String n = uri.getQueryParameter("name");
        return n != null && !n.isEmpty() ? n : f.getName();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = nameOf(uri, f);
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        try {
            File f = fileFor(uri);
            return MimeTypes.forName(nameOf(uri, f));
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !mode.equals("r")) throw new FileNotFoundException("Sólo lectura");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
