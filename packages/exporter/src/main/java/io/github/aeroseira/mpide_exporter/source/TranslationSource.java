package io.github.aeroseira.mpide_exporter.source;

import com.mojang.logging.LogUtils;
import net.minecraft.locale.Language;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.packs.PackResources;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.server.packs.resources.Resource;
import net.minecraft.server.packs.resources.ResourceManager;
import org.slf4j.Logger;

import java.io.InputStream;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Captures final language entries into {@code translations}. */
public final class TranslationSource {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String LANG_PREFIX = "lang/";
    private static final String LANG_SUFFIX = ".json";

    private TranslationSource() {}

    public record TranslationRow(String key, String lang, String value) {}

    private record RowKey(String key, String lang) {}

    public static List<TranslationRow> capture(MinecraftServer server) {
        Map<RowKey, String> rows = new HashMap<>();

        loadClasspathLanguage(rows, "assets/minecraft/lang/en_us.json", Language.DEFAULT);
        loadClasspathLanguage(rows, "assets/neoforge/lang/en_us.json", Language.DEFAULT);
        loadClientResourceLanguages(server, rows);

        return rows.entrySet().stream()
            .map(entry -> new TranslationRow(entry.getKey().key(), entry.getKey().lang(), entry.getValue()))
            .sorted(Comparator.comparing(TranslationRow::key).thenComparing(TranslationRow::lang))
            .toList();
    }

    private static void loadClientResourceLanguages(MinecraftServer server, Map<RowKey, String> rows) {
        List<PackResources> packs = server.getResourceManager().listPacks().toList();
        // This wrapper shares server-owned PackResources; do not close it.
        ResourceManager clientResources = new MultiPackResourceManager(PackType.CLIENT_RESOURCES, packs);

        clientResources.listResourceStacks("lang", TranslationSource::isLanguageResource)
            .forEach((location, stack) -> {
                String lang = langFromPath(location.getPath());
                if (lang == null) {
                    return;
                }

                for (Resource resource : stack) {
                    try (InputStream stream = resource.open()) {
                        loadLanguageStream(rows, lang, stream);
                    } catch (Exception e) {
                        LOGGER.warn(
                            "Skipped language resource {} from {}",
                            location,
                            resource.sourcePackId(),
                            e
                        );
                    }
                }
            });
    }

    private static void loadClasspathLanguage(Map<RowKey, String> rows, String path, String lang) {
        ClassLoader classLoader = Thread.currentThread().getContextClassLoader();
        InputStream stream = classLoader == null ? null : classLoader.getResourceAsStream(path);
        if (stream == null) {
            stream = TranslationSource.class.getClassLoader().getResourceAsStream(path);
        }
        if (stream == null) {
            return;
        }

        try (InputStream languageStream = stream) {
            loadLanguageStream(rows, lang, languageStream);
        } catch (Exception e) {
            LOGGER.warn("Skipped classpath language resource {}", path, e);
        }
    }

    private static void loadLanguageStream(Map<RowKey, String> rows, String lang, InputStream stream) {
        Language.loadFromJson(stream, (key, value) -> put(rows, key, lang, value));
    }

    private static void put(Map<RowKey, String> rows, String key, String lang, String value) {
        if (key == null || key.isBlank() || lang == null || lang.isBlank() || value == null) {
            return;
        }
        rows.put(new RowKey(key, lang.toLowerCase(Locale.ROOT)), value);
    }

    private static boolean isLanguageResource(ResourceLocation location) {
        return langFromPath(location.getPath()) != null;
    }

    private static String langFromPath(String path) {
        if (!path.startsWith(LANG_PREFIX) || !path.endsWith(LANG_SUFFIX)) {
            return null;
        }

        String lang = path.substring(LANG_PREFIX.length(), path.length() - LANG_SUFFIX.length());
        return lang.isBlank() ? null : lang.toLowerCase(Locale.ROOT);
    }
}
