package io.github.aeroseira.mpide_exporter.source;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.packs.PackResources;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.server.packs.resources.Resource;
import net.minecraft.server.packs.resources.ResourceManager;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import org.slf4j.Logger;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** 采集物品图标贴图到 {@code item_resources}。 */
public final class ItemResourceSource {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Gson GSON = new Gson();
    private static final String RESOURCE_TYPE_TEXTURE = "texture";
    private static final String LAYER0 = "layer0";
    private static final int MAX_PARENT_DEPTH = 32;

    private ItemResourceSource() {}

    public record ItemResourceRow(
        String itemId,
        String resourceType,
        String namespace,
        String path,
        String content
    ) {}

    public static List<ItemResourceRow> capture(MinecraftServer server) {
        List<PackResources> packs = server.getResourceManager().listPacks().toList();
        // 共享 server-owned PackResources；这里不能 close 这个包装器。
        ResourceManager clientResources = new MultiPackResourceManager(PackType.CLIENT_RESOURCES, packs);

        List<ItemResourceRow> rows = new ArrayList<>();
        for (Map.Entry<net.minecraft.resources.ResourceKey<Item>, Item> entry : BuiltInRegistries.ITEM.entrySet()) {
            if (entry.getValue() == Items.AIR) {
                continue;
            }

            ResourceLocation itemId = entry.getKey().location();
            try {
                captureItem(clientResources, itemId).ifPresent(rows::add);
            } catch (RuntimeException exception) {
                LOGGER.debug("跳过物品 {} 的贴图导出：{}", itemId, exception.getMessage(), exception);
            }
        }

        return rows.stream()
            .sorted(Comparator.comparing(ItemResourceRow::itemId))
            .toList();
    }

    private static Optional<ItemResourceRow> captureItem(ResourceManager clientResources, ResourceLocation itemId) {
        LinkedHashSet<ResourceLocation> candidates = new LinkedHashSet<>();
        resolveModelLayer0(clientResources, itemId).ifPresent(candidates::add);
        candidates.add(ResourceLocation.fromNamespaceAndPath(itemId.getNamespace(), "item/" + itemId.getPath()));
        candidates.add(ResourceLocation.fromNamespaceAndPath(itemId.getNamespace(), "block/" + itemId.getPath()));

        for (ResourceLocation textureId : candidates) {
            Optional<byte[]> bytes = readTexturePng(clientResources, itemId, textureId);
            if (bytes.isEmpty()) {
                continue;
            }

            return Optional.of(new ItemResourceRow(
                itemId.toString(),
                RESOURCE_TYPE_TEXTURE,
                textureId.getNamespace(),
                textureId.getPath(),
                Base64.getEncoder().encodeToString(bytes.get())
            ));
        }

        LOGGER.debug("跳过物品 {} 的贴图导出：未找到可读取的 PNG 资源", itemId);
        return Optional.empty();
    }

    private static Optional<ResourceLocation> resolveModelLayer0(ResourceManager clientResources, ResourceLocation itemId) {
        ResourceLocation modelId = ResourceLocation.fromNamespaceAndPath(itemId.getNamespace(), "item/" + itemId.getPath());
        Map<String, String> textures = new HashMap<>();
        Set<ResourceLocation> visited = new HashSet<>();

        for (int depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
            if (!visited.add(modelId)) {
                LOGGER.debug("跳过物品 {} 的模型 parent 链：检测到循环 {}", itemId, modelId);
                break;
            }

            Optional<JsonObject> model = readModelJson(clientResources, itemId, modelId);
            if (model.isEmpty()) {
                break;
            }

            mergeTextureDefinitions(textures, model.get());
            Optional<ResourceLocation> layer0 = resolveTextureReference(textures, LAYER0, itemId.toString());
            if (layer0.isPresent()) {
                return layer0;
            }

            Optional<ResourceLocation> parent = readParentModelId(model.get(), itemId, modelId);
            if (parent.isEmpty()) {
                break;
            }
            modelId = parent.get();
        }

        LOGGER.debug("物品 {} 的模型未解析到 textures.layer0", itemId);
        return Optional.empty();
    }

    private static Optional<JsonObject> readModelJson(
        ResourceManager clientResources,
        ResourceLocation itemId,
        ResourceLocation modelId
    ) {
        ResourceLocation modelResource = ResourceLocation.fromNamespaceAndPath(
            modelId.getNamespace(),
            "models/" + modelId.getPath() + ".json"
        );
        Optional<Resource> resource = clientResources.getResource(modelResource);
        if (resource.isEmpty()) {
            return Optional.empty();
        }

        try (
            InputStream stream = resource.get().open();
            InputStreamReader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)
        ) {
            JsonElement json = GSON.fromJson(reader, JsonElement.class);
            if (json == null || !json.isJsonObject()) {
                LOGGER.debug("跳过物品 {} 的模型 {}：JSON 根节点不是对象", itemId, modelResource);
                return Optional.empty();
            }
            return Optional.of(json.getAsJsonObject());
        } catch (Exception exception) {
            LOGGER.debug("跳过物品 {} 的模型 {}：读取或解析失败", itemId, modelResource, exception);
            return Optional.empty();
        }
    }

    private static void mergeTextureDefinitions(Map<String, String> textures, JsonObject model) {
        JsonElement texturesJson = model.get("textures");
        if (texturesJson == null || !texturesJson.isJsonObject()) {
            return;
        }

        for (Map.Entry<String, JsonElement> entry : texturesJson.getAsJsonObject().entrySet()) {
            JsonElement value = entry.getValue();
            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                continue;
            }

            String texture = value.getAsString();
            if (!texture.isBlank()) {
                textures.putIfAbsent(entry.getKey(), texture);
            }
        }
    }

    private static Optional<ResourceLocation> readParentModelId(
        JsonObject model,
        ResourceLocation itemId,
        ResourceLocation currentModelId
    ) {
        String parent = stringProperty(model, "parent");
        if (parent == null || parent.startsWith("builtin/")) {
            return Optional.empty();
        }

        try {
            return Optional.of(ResourceLocation.parse(parent));
        } catch (RuntimeException exception) {
            LOGGER.debug("跳过物品 {} 的模型 parent {}（当前模型 {}）：ResourceLocation 无效",
                itemId,
                parent,
                currentModelId,
                exception);
            return Optional.empty();
        }
    }

    private static Optional<ResourceLocation> resolveTextureReference(
        Map<String, String> textures,
        String key,
        String itemId
    ) {
        Set<String> visited = new HashSet<>();
        String currentKey = key;

        for (int depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
            if (!visited.add(currentKey)) {
                LOGGER.debug("跳过物品 {} 的贴图引用：检测到循环 #{}", itemId, currentKey);
                return Optional.empty();
            }

            String value = textures.get(currentKey);
            if (value == null || value.isBlank()) {
                return Optional.empty();
            }

            if (value.startsWith("#")) {
                currentKey = value.substring(1);
                if (currentKey.isBlank()) {
                    return Optional.empty();
                }
                continue;
            }

            try {
                return Optional.of(ResourceLocation.parse(value));
            } catch (RuntimeException exception) {
                LOGGER.debug("跳过物品 {} 的贴图引用 {}：ResourceLocation 无效", itemId, value, exception);
                return Optional.empty();
            }
        }

        LOGGER.debug("跳过物品 {} 的贴图引用：#{} 解析深度超过 {}", itemId, key, MAX_PARENT_DEPTH);
        return Optional.empty();
    }

    private static Optional<byte[]> readTexturePng(
        ResourceManager clientResources,
        ResourceLocation itemId,
        ResourceLocation textureId
    ) {
        ResourceLocation textureResource = ResourceLocation.fromNamespaceAndPath(
            textureId.getNamespace(),
            "textures/" + textureId.getPath() + ".png"
        );
        Optional<Resource> resource = clientResources.getResource(textureResource);
        if (resource.isEmpty()) {
            return Optional.empty();
        }

        try (InputStream stream = resource.get().open()) {
            return Optional.of(stream.readAllBytes());
        } catch (Exception exception) {
            LOGGER.debug("跳过物品 {} 的贴图候选 {}：PNG 读取失败", itemId, textureResource, exception);
            return Optional.empty();
        }
    }

    private static String stringProperty(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value == null || !value.isJsonPrimitive() ? null : value.getAsString();
    }
}
