package io.github.aeroseira.mpide_exporter.source;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.mojang.logging.LogUtils;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ReloadableServerRegistries;
import net.minecraft.world.level.storage.loot.LootTable;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Captures final-state loot tables into {@code loot_tables}, plus exact
 * block/entity → loot table bindings into {@code loot_bindings}.
 *
 * 机制说明（1.21.1，已对 merged jar 做字节级核实）：
 *  - 战利品表是数据驱动注册表 {@code Registries.LOOT_TABLE}，但加载在
 *    RELOADABLE 层——{@code server.registryAccess()} 的 composite 视图不含它
 *    （registryOrThrow 会抛 Missing registry），必须经
 *    {@code server.reloadableRegistries()} 枚举：{@code getKeys} 在注册表缺失时
 *    返回空集合，{@code getLootTable} 在表缺失时回退 {@code LootTable.EMPTY}。
 *    运行时即最终态（vanilla + mods + datapack/KubeJS 覆盖都会反映在这里）。
 *  - 方块绑定 {@code BlockBehaviour#getLootTable()}、实体绑定
 *    {@code EntityType#getDefaultLootTable()} 返回的是路径约定 key
 *    （blocks/<path>、entities/<path>），对应的表可能并不存在
 *    （如无掉落实体），因此只保留注册表中真实存在的绑定，并剔除 minecraft:empty。
 *  - NeoForge Global Loot Modifiers 在 roll 时叠加，不属于表本身，不在本 source 范围。
 */
public final class LootTableSource {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final String EMPTY_TABLE_ID = "minecraft:empty";

    private LootTableSource() {}

    public record Snapshot(
        RegistryAccess registries,
        List<Map.Entry<ResourceKey<LootTable>, LootTable>> tables,
        List<BindingRow> bindings
    ) {}

    public record Rows(
        List<LootTableRow> tables,
        List<BindingRow> bindings
    ) {}

    public record LootTableRow(String lootTableId, String json) {}

    /** kind: {@code block} | {@code entity}；source_id: 方块/实体注册 ID。 */
    public record BindingRow(String kind, String sourceId, String lootTableId) {}

    public static Snapshot capture(MinecraftServer server) {
        ReloadableServerRegistries.Holder holder = server.reloadableRegistries();
        RegistryAccess registries = holder.get();

        List<ResourceLocation> ids = holder.getKeys(Registries.LOOT_TABLE).stream()
            .sorted(Comparator.comparing(ResourceLocation::toString))
            .toList();
        List<Map.Entry<ResourceKey<LootTable>, LootTable>> tables = new ArrayList<>(ids.size());
        Set<String> existingIds = new HashSet<>();
        for (ResourceLocation id : ids) {
            ResourceKey<LootTable> key = ResourceKey.create(Registries.LOOT_TABLE, id);
            LootTable table = holder.getLootTable(key);
            if (table == null || table == LootTable.EMPTY) {
                continue;
            }
            existingIds.add(id.toString());
            tables.add(Map.entry(key, table));
        }

        List<BindingRow> bindings = new ArrayList<>();
        BuiltInRegistries.BLOCK.forEach(block -> {
            ResourceKey<LootTable> key = block.getLootTable();
            if (key != null && isUsable(existingIds, key)) {
                bindings.add(new BindingRow(
                    "block",
                    BuiltInRegistries.BLOCK.getKey(block).toString(),
                    key.location().toString()
                ));
            }
        });
        BuiltInRegistries.ENTITY_TYPE.forEach(entityType -> {
            ResourceKey<LootTable> key = entityType.getDefaultLootTable();
            if (key != null && isUsable(existingIds, key)) {
                bindings.add(new BindingRow(
                    "entity",
                    BuiltInRegistries.ENTITY_TYPE.getKey(entityType).toString(),
                    key.location().toString()
                ));
            }
        });
        bindings.sort(Comparator.comparing(BindingRow::kind).thenComparing(BindingRow::sourceId));

        return new Snapshot(registries, List.copyOf(tables), List.copyOf(bindings));
    }

    /** 剔除空表占位与"约定 key 存在但表不存在"的绑定。 */
    private static boolean isUsable(Set<String> existingIds, ResourceKey<LootTable> key) {
        return !EMPTY_TABLE_ID.equals(key.location().toString()) && existingIds.contains(key.location().toString());
    }

    public static Rows materialize(Snapshot snapshot) {
        RegistryOps<JsonElement> ops = snapshot.registries().createSerializationContext(JsonOps.INSTANCE);
        List<LootTableRow> rows = new ArrayList<>(snapshot.tables().size());

        for (Map.Entry<ResourceKey<LootTable>, LootTable> entry : snapshot.tables()) {
            String lootTableId = entry.getKey().location().toString();
            try {
                LootTable.DIRECT_CODEC.encodeStart(ops, entry.getValue())
                    .resultOrPartial(message -> LOGGER.warn("Failed to encode loot table {}: {}", lootTableId, message))
                    .ifPresent(json -> rows.add(new LootTableRow(lootTableId, GSON.toJson(json))));
            } catch (RuntimeException exception) {
                LOGGER.warn("Failed to encode loot table {} ({}: {}); skipping",
                    lootTableId, exception.getClass().getSimpleName(), exception.getMessage());
            }
        }

        return new Rows(List.copyOf(rows), snapshot.bindings());
    }
}
