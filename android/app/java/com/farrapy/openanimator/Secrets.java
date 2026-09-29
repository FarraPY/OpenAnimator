package com.farrapy.openanimator;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API keys (Claude, OpenAI, ElevenLabs…) encrypted with a key that lives in the Android Keystore.
 * They are stored outside the data folder, never returned to JavaScript (only a masked form) and
 * only used by Java when it sends a request.
 */
final class Secrets {
    private static final String TAG = "OpenAnimator";
    private static final String ALIAS = "openanimator-secrets-v1";
    private final File file;

    Secrets(File file) {
        this.file = file;
    }

    private JSONObject load() {
        try {
            return new JSONObject(new String(Fs.readBytes(file, 1 << 20), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private void save(JSONObject o) throws IOException {
        Fs.writeAtomic(file, o.toString().getBytes(StandardCharsets.UTF_8));
    }

    synchronized void set(String name, String value) throws IOException, JSONException {
        JSONObject o = load();
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) {
            o.remove(name);
        } else {
            JSONObject e = new JSONObject();
            try {
                e.put("v", encrypt(v));
                e.put("enc", true);
            } catch (Exception ex) {
                Log.w(TAG, "Keystore no disponible; la clave se guarda sin cifrar", ex);
                e.put("v", Base64.encodeToString(v.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                e.put("enc", false);
            }
            o.put(name, e);
        }
        save(o);
    }

    synchronized String get(String name) {
        JSONObject e = load().optJSONObject(name);
        if (e == null) return "";
        try {
            String v = e.getString("v");
            if (e.optBoolean("enc")) return decrypt(v);
            return new String(Base64.decode(v, Base64.NO_WRAP), StandardCharsets.UTF_8);
        } catch (Exception ex) {
            Log.w(TAG, "No se pudo leer la clave " + name, ex);
            return "";
        }
    }

    /** "sk-…a1B2", like the PC version. */
    String masked(String name) {
        String v = get(name);
        if (v.isEmpty()) return "";
        if (v.length() <= 8) return "…" + v.substring(Math.max(0, v.length() - 2));
        return v.substring(0, 3) + "…" + v.substring(v.length() - 4);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static String encrypt(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[1 + iv.length + ct.length];
        all[0] = (byte) iv.length;
        System.arraycopy(iv, 0, all, 1, iv.length);
        System.arraycopy(ct, 0, all, 1 + iv.length, ct.length);
        return Base64.encodeToString(all, Base64.NO_WRAP);
    }

    private static String decrypt(String data) throws Exception {
        byte[] all = Base64.decode(data, Base64.NO_WRAP);
        int ivLen = all[0];
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 1, ivLen));
        byte[] pt = c.doFinal(all, 1 + ivLen, all.length - 1 - ivLen);
        return new String(pt, StandardCharsets.UTF_8);
    }
}
