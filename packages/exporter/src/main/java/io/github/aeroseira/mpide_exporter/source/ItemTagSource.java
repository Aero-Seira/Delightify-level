package io.github.aeroseira.mpide_exporter.source;

import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.Item;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/** Captures final resolved item tag membership into {@code item_tags}. */
public final class ItemTagSource {

    private ItemTagSource() {}

    public record ItemTagRow(String tagId, String itemId) {}

    public static List<ItemTagRow> capture(MinecraftServer server) {
        HolderLookup.RegistryLookup<Item> items = server.registryAccess().lookupOrThrow(Registries.ITEM);
        List<ItemTagRow> rows = new ArrayList<>();

        items.listTags().forEach(tag -> {
            String tagId = tag.key().location().toString();
            tag.stream()
                .map(holder -> holder.unwrapKey().map(key -> key.location().toString()).orElse(null))
                .filter(Objects::nonNull)
                .forEach(itemId -> rows.add(new ItemTagRow(tagId, itemId)));
        });

        rows.sort(Comparator.comparing(ItemTagRow::tagId).thenComparing(ItemTagRow::itemId));
        return List.copyOf(rows);
    }
}
