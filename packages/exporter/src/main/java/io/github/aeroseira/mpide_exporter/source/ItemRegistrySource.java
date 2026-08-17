package io.github.aeroseira.mpide_exporter.source;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockState;
import org.slf4j.Logger;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/** Captures registry facts for {@code items}, {@code item_creative_tabs}, and {@code blocks}. */
public final class ItemRegistrySource {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final Map<SoundType, String> SOUND_TYPE_NAMES = soundTypeNames();

    private ItemRegistrySource() {}

    public record Snapshot(
        HolderLookup.Provider registries,
        List<ItemSnapshot> items,
        List<ItemCreativeTabRow> creativeTabs,
        List<BlockRow> blocks
    ) {}

    public record Rows(
        List<ItemRow> items,
        List<ItemCreativeTabRow> creativeTabs,
        List<BlockRow> blocks
    ) {}

    public record ItemSnapshot(
        String itemId,
        String modid,
        String translationKey,
        boolean block,
        int maxStack,
        int maxDamage,
        boolean damageable,
        boolean fireResistant,
        String rarity,
        int enchantValue,
        Integer foodNutrition,
        Double foodSaturation,
        Integer foodAlwaysEat,
        DataComponentMap defaultComponents
    ) {}

    public record ItemRow(
        String itemId,
        String modid,
        String translationKey,
        boolean block,
        int maxStack,
        int maxDamage,
        boolean damageable,
        boolean fireResistant,
        String rarity,
        int enchantValue,
        Integer foodNutrition,
        Double foodSaturation,
        Integer foodAlwaysEat,
        String defaultComponentsJson
    ) {}

    public record ItemCreativeTabRow(String itemId, String tabId) {}

    public record BlockRow(
        String blockId,
        String itemId,
        Double hardness,
        Double resistance,
        Integer lightEmission,
        Boolean requiresCorrectTool,
        String soundType
    ) {}

    public static Snapshot capture(MinecraftServer server) {
        HolderLookup.Provider registries = server.registryAccess();
        CreativeModeTabs.tryRebuildTabContents(server.getWorldData().enabledFeatures(), true, registries);

        List<ItemSnapshot> items = new ArrayList<>();
        List<BlockRow> blocks = new ArrayList<>();
        for (Map.Entry<net.minecraft.resources.ResourceKey<Item>, Item> entry : BuiltInRegistries.ITEM.entrySet()) {
            Item item = entry.getValue();
            if (item == Items.AIR) {
                continue;
            }

            ResourceLocation itemId = entry.getKey().location();
            ItemStack stack = defaultStack(item);
            Block block = blockFor(item);
            boolean isBlock = block != Blocks.AIR;

            FoodProperties food = stack.get(DataComponents.FOOD);
            items.add(new ItemSnapshot(
                itemId.toString(),
                itemId.getNamespace(),
                blankToNull(stack.getDescriptionId()),
                isBlock,
                stack.getMaxStackSize(),
                stack.getMaxDamage(),
                stack.isDamageableItem(),
                stack.has(DataComponents.FIRE_RESISTANT),
                stack.getRarity().getSerializedName(),
                item.getEnchantmentValue(stack),
                food == null ? null : food.nutrition(),
                food == null ? null : (double) food.saturation(),
                food == null ? null : boolInt(food.canAlwaysEat()),
                DataComponentMap.builder().addAll(stack.getComponents()).build()
            ));

            if (isBlock) {
                blocks.add(toBlockRow(block, itemId.toString()));
            }
        }

        items.sort(Comparator.comparing(ItemSnapshot::itemId));
        blocks.sort(Comparator.comparing(BlockRow::blockId).thenComparing(BlockRow::itemId, Comparator.nullsFirst(String::compareTo)));

        return new Snapshot(
            registries,
            List.copyOf(items),
            captureCreativeTabs(),
            List.copyOf(blocks)
        );
    }

    public static Rows materialize(Snapshot snapshot) {
        List<ItemRow> rows = snapshot.items().stream()
            .map(item -> new ItemRow(
                item.itemId(),
                item.modid(),
                item.translationKey(),
                item.block(),
                item.maxStack(),
                item.maxDamage(),
                item.damageable(),
                item.fireResistant(),
                item.rarity(),
                item.enchantValue(),
                item.foodNutrition(),
                item.foodSaturation(),
                item.foodAlwaysEat(),
                encodeComponents(snapshot.registries(), item.defaultComponents(), item.itemId())
            ))
            .toList();

        return new Rows(rows, snapshot.creativeTabs(), snapshot.blocks());
    }

    private static ItemStack defaultStack(Item item) {
        ItemStack stack = item.getDefaultInstance();
        return stack.isEmpty() ? new ItemStack(item) : stack;
    }

    private static Block blockFor(Item item) {
        return item instanceof BlockItem blockItem ? blockItem.getBlock() : Blocks.AIR;
    }

    private static List<ItemCreativeTabRow> captureCreativeTabs() {
        Map<String, Set<String>> tabsByItem = new TreeMap<>();
        for (CreativeModeTab tab : CreativeModeTabs.allTabs()) {
            if (tab.getType() != CreativeModeTab.Type.CATEGORY) {
                continue;
            }

            ResourceLocation tabId = BuiltInRegistries.CREATIVE_MODE_TAB.getKey(tab);
            if (tabId == null) {
                continue;
            }

            for (ItemStack stack : tab.getDisplayItems()) {
                if (stack.isEmpty() || stack.getItem() == Items.AIR) {
                    continue;
                }
                ResourceLocation itemId = BuiltInRegistries.ITEM.getKey(stack.getItem());
                if (itemId != null) {
                    tabsByItem.computeIfAbsent(itemId.toString(), ignored -> new TreeSet<>()).add(tabId.toString());
                }
            }
        }

        List<ItemCreativeTabRow> rows = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : tabsByItem.entrySet()) {
            for (String tabId : entry.getValue()) {
                rows.add(new ItemCreativeTabRow(entry.getKey(), tabId));
            }
        }
        return List.copyOf(rows);
    }

    @SuppressWarnings("deprecation")
    private static BlockRow toBlockRow(Block block, String itemId) {
        ResourceLocation blockId = BuiltInRegistries.BLOCK.getKey(block);
        BlockState state = block.defaultBlockState();
        return new BlockRow(
            blockId == null ? itemId : blockId.toString(),
            itemId,
            (double) state.getDestroySpeed(null, BlockPos.ZERO),
            (double) block.getExplosionResistance(),
            state.getLightEmission(),
            state.requiresCorrectToolForDrops(),
            describeSoundType(state.getSoundType())
        );
    }

    private static String encodeComponents(HolderLookup.Provider registries, DataComponentMap components, String itemId) {
        RegistryOps<JsonElement> ops = registries.createSerializationContext(JsonOps.INSTANCE);
        Optional<JsonElement> encoded = DataComponentMap.CODEC.encodeStart(ops, components)
            .resultOrPartial(message -> LOGGER.warn("Failed to encode default components for {}: {}", itemId, message));
        return encoded.map(ItemRegistrySource::canonicalJson).orElse(null);
    }

    private static String canonicalJson(JsonElement json) {
        return GSON.toJson(sortJson(json));
    }

    private static JsonElement sortJson(JsonElement json) {
        if (json == null || json.isJsonNull() || json.isJsonPrimitive()) {
            return json;
        }
        if (json.isJsonArray()) {
            JsonArray sorted = new JsonArray();
            for (JsonElement child : json.getAsJsonArray()) {
                sorted.add(sortJson(child));
            }
            return sorted;
        }

        JsonObject sorted = new JsonObject();
        json.getAsJsonObject().entrySet().stream()
            .sorted(Map.Entry.comparingByKey())
            .forEach(entry -> sorted.add(entry.getKey(), sortJson(entry.getValue())));
        return sorted;
    }

    private static String describeSoundType(SoundType soundType) {
        String knownName = SOUND_TYPE_NAMES.get(soundType);
        if (knownName != null) {
            return knownName;
        }

        return soundType.getClass().getName()
            + "{volume=" + soundType.getVolume()
            + ",pitch=" + soundType.getPitch()
            + ",break=" + soundEventKey(soundType.getBreakSound())
            + ",step=" + soundEventKey(soundType.getStepSound())
            + ",place=" + soundEventKey(soundType.getPlaceSound())
            + ",hit=" + soundEventKey(soundType.getHitSound())
            + ",fall=" + soundEventKey(soundType.getFallSound())
            + "}";
    }

    private static String soundEventKey(net.minecraft.sounds.SoundEvent soundEvent) {
        ResourceLocation key = BuiltInRegistries.SOUND_EVENT.getKey(soundEvent);
        return key == null ? soundEvent.toString() : key.toString();
    }

    private static Map<SoundType, String> soundTypeNames() {
        Map<SoundType, String> names = new IdentityHashMap<>();
        for (Field field : SoundType.class.getFields()) {
            int modifiers = field.getModifiers();
            if (!Modifier.isStatic(modifiers) || field.getType() != SoundType.class) {
                continue;
            }
            try {
                names.putIfAbsent((SoundType) field.get(null), field.getName().toLowerCase(Locale.ROOT));
            } catch (IllegalAccessException ignored) {
                // Public fields are expected here; skip only if a custom runtime blocks access.
            }
        }
        return Map.copyOf(names);
    }

    private static int boolInt(boolean value) {
        return value ? 1 : 0;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
