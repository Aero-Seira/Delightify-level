package io.github.aeroseira.mpide_exporter.client;

import io.github.aeroseira.mpide_exporter.source.ItemRegistrySource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;

/** 客户端最终态物品图标 PNG 缓存。 */
final class IconCache {

    static final int ICON_SIZE = 64;
    private static final String CACHE_VERSION = "client-render-v3";

    private final Path cacheDir;
    private final Map<String, String> manifest;
    private final String resourcePackSignature;

    IconCache(Path exportDir, Map<String, String> manifest, String resourcePackSignature) {
        this.cacheDir = exportDir.resolve("icon-cache").resolve("v1");
        this.manifest = manifest;
        this.resourcePackSignature = resourcePackSignature;
    }

    Path pathFor(ItemRegistrySource.ItemRow item) {
        return cacheDir.resolve(cacheKey(item) + ".png");
    }

    byte[] read(Path path) throws IOException {
        return Files.readAllBytes(path);
    }

    void write(Path path, byte[] png) throws IOException {
        Files.createDirectories(path.getParent());
        Files.write(path, png);
    }

    private String cacheKey(ItemRegistrySource.ItemRow item) {
        String value = String.join("\n",
            CACHE_VERSION,
            item.itemId(),
            nullToEmpty(item.defaultComponentsJson()),
            nullToEmpty(manifest.get("modlist_hash")),
            nullToEmpty(manifest.get("mc_version")),
            resourcePackSignature,
            String.valueOf(ICON_SIZE)
        );
        return sha256(value);
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception exception) {
            return Integer.toHexString(value.hashCode());
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
