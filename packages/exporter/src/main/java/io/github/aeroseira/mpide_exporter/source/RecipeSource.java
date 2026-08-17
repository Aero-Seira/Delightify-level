package io.github.aeroseira.mpide_exporter.source;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponentPatch;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeSerializer;
import net.minecraft.world.item.crafting.ShapedRecipe;
import org.slf4j.Logger;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Captures runtime recipes into {@code recipes}, {@code recipe_inputs}, and {@code recipe_outputs}. */
public final class RecipeSource {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private RecipeSource() {}

    public record Snapshot(
        HolderLookup.Provider registries,
        List<RecipeHolder<?>> recipes
    ) {}

    public record Rows(
        List<RecipeRow> recipes,
        List<RecipeInputRow> inputs,
        List<RecipeOutputRow> outputs
    ) {}

    public record RecipeRow(
        String recipeId,
        String typeId,
        String modid,
        String hash,
        String rawJson,
        boolean unparsed,
        String group,
        Integer inputWidth,
        Integer inputHeight
    ) {}

    public record RecipeInputRow(
        String recipeId,
        int slot,
        String role,
        String kind,
        String ref,
        int count
    ) {}

    public record RecipeOutputRow(
        String recipeId,
        int slot,
        String itemId,
        int count,
        String componentsJson,
        boolean primary
    ) {}

    public static Snapshot capture(MinecraftServer server) {
        List<RecipeHolder<?>> recipes = server.getRecipeManager().getRecipes().stream()
            .sorted(Comparator.comparing(holder -> holder.id().toString()))
            .toList();
        return new Snapshot(server.registryAccess(), recipes);
    }

    public static Rows materialize(Snapshot snapshot) {
        RegistryOps<JsonElement> ops = snapshot.registries().createSerializationContext(JsonOps.INSTANCE);
        List<RecipeRow> recipes = new ArrayList<>();
        List<RecipeInputRow> inputs = new ArrayList<>();
        List<RecipeOutputRow> outputs = new ArrayList<>();

        for (RecipeHolder<?> holder : snapshot.recipes()) {
            MaterializedRecipe materialized;
            try {
                materialized = materializeRecipe(snapshot.registries(), ops, holder);
            } catch (RuntimeException exception) {
                materialized = unparsedRecipe(holder, exception);
            }
            recipes.add(materialized.recipe());
            inputs.addAll(materialized.inputs());
            outputs.addAll(materialized.outputs());
        }

        recipes.sort(Comparator.comparing(RecipeRow::recipeId));
        inputs = inputs.stream()
            .distinct()
            .sorted(Comparator.comparing(RecipeInputRow::recipeId)
                .thenComparingInt(RecipeInputRow::slot)
                .thenComparing(RecipeInputRow::role)
                .thenComparing(RecipeInputRow::kind)
                .thenComparing(row -> row.ref() == null ? "" : row.ref()))
            .toList();
        outputs = outputs.stream()
            .distinct()
            .sorted(Comparator.comparing(RecipeOutputRow::recipeId)
                .thenComparingInt(RecipeOutputRow::slot)
                .thenComparing(RecipeOutputRow::itemId))
            .toList();

        return new Rows(List.copyOf(recipes), inputs, outputs);
    }

    private static MaterializedRecipe materializeRecipe(
        HolderLookup.Provider registries,
        RegistryOps<JsonElement> ops,
        RecipeHolder<?> holder
    ) {
        Recipe<?> recipe = holder.value();
        String recipeId = holder.id().toString();
        String typeId = safeRecipeTypeId(recipe, recipeId);
        JsonElement rawElement = encodeRecipe(ops, recipe, recipeId).orElse(null);
        String rawJson = rawElement == null ? null : canonicalJson(rawElement);

        List<RecipeInputRow> inputs = new ArrayList<>();
        boolean inputsStructured = true;
        try {
            inputsStructured = addIngredientRows(recipeId, recipe.getIngredients(), inputs);
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to read recipe ingredients for {} ({}: {}); marking recipe unparsed",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            inputsStructured = false;
        }
        if (inputs.isEmpty() && rawElement instanceof JsonObject rawObject) {
            inputsStructured = addJsonFallbackInputs(ops, recipeId, rawObject, inputs);
        }

        boolean unparsed = rawJson == null || safeIsSpecial(recipe, recipeId) || !inputsStructured;
        List<RecipeOutputRow> outputs = unparsed ? List.of() : outputRows(registries, recipeId, recipe);
        int[] gridSize = safeGridSize(recipe, recipeId);

        RecipeRow row = new RecipeRow(
            recipeId,
            typeId,
            holder.id().getNamespace(),
            sha256(rawJson == null ? recipeId + "\n" + typeId : rawJson),
            rawJson,
            unparsed,
            safeGroup(recipe, recipeId),
            gridSize == null ? null : gridSize[0],
            gridSize == null ? null : gridSize[1]
        );

        return new MaterializedRecipe(row, List.copyOf(inputs), outputs);
    }

    private static boolean addIngredientRows(String recipeId, List<Ingredient> ingredients, List<RecipeInputRow> rows) {
        boolean structured = true;
        int slot = 0;
        for (Ingredient ingredient : ingredients) {
            if (ingredient.isEmpty()) {
                slot++;
                continue;
            }
            structured &= addIngredientRows(recipeId, slot, "input", ingredient, rows);
            slot++;
        }
        return structured;
    }

    private static boolean addIngredientRows(
        String recipeId,
        int slot,
        String role,
        Ingredient ingredient,
        List<RecipeInputRow> rows
    ) {
        if (ingredient.isEmpty()) {
            return true;
        }
        if (ingredient.isCustom()) {
            rows.add(new RecipeInputRow(recipeId, slot, role, "custom", null, 1));
            return false;
        }

        boolean structured = true;
        Ingredient.Value[] values = ingredient.getValues();
        if (values.length == 0) {
            rows.add(new RecipeInputRow(recipeId, slot, role, "custom", null, 1));
            return false;
        }

        for (Ingredient.Value value : values) {
            if (value instanceof Ingredient.ItemValue itemValue) {
                ItemStack stack = itemValue.item();
                ResourceLocation itemId = BuiltInRegistries.ITEM.getKey(stack.getItem());
                if (stack.isEmpty() || stack.getItem() == Items.AIR || itemId == null) {
                    structured = false;
                    continue;
                }
                rows.add(new RecipeInputRow(recipeId, slot, role, "item", itemId.toString(), Math.max(1, stack.getCount())));
            } else if (value instanceof Ingredient.TagValue tagValue) {
                rows.add(new RecipeInputRow(recipeId, slot, role, "tag", tagValue.tag().location().toString(), 1));
            } else {
                structured = false;
            }
        }

        if (!structured) {
            rows.add(new RecipeInputRow(recipeId, slot, role, "custom", null, 1));
        }
        return structured;
    }

    private static boolean addJsonFallbackInputs(
        RegistryOps<JsonElement> ops,
        String recipeId,
        JsonObject raw,
        List<RecipeInputRow> rows
    ) {
        if (raw.has("template") || raw.has("base") || raw.has("addition")) {
            boolean structured = true;
            structured &= addJsonIngredientRow(ops, recipeId, 0, "input", raw.get("template"), rows);
            structured &= addJsonIngredientRow(ops, recipeId, 1, "input", raw.get("base"), rows);
            structured &= addJsonIngredientRow(ops, recipeId, 2, "input", raw.get("addition"), rows);
            return structured;
        }

        if (raw.has("ingredient")) {
            return addJsonIngredientRow(ops, recipeId, 0, "input", raw.get("ingredient"), rows);
        }

        if (raw.get("ingredients") instanceof JsonArray ingredients) {
            boolean structured = true;
            int slot = 0;
            for (JsonElement ingredient : ingredients) {
                structured &= addJsonIngredientRow(ops, recipeId, slot, "input", ingredient, rows);
                slot++;
            }
            return structured;
        }

        return false;
    }

    private static boolean addJsonIngredientRow(
        RegistryOps<JsonElement> ops,
        String recipeId,
        int slot,
        String role,
        JsonElement json,
        List<RecipeInputRow> rows
    ) {
        if (json == null || json.isJsonNull()) {
            return true;
        }

        if (isFluidIngredientJson(json)) {
            rows.add(new RecipeInputRow(recipeId, slot, role, "custom", null, 1));
            return false;
        }

        Optional<Ingredient> ingredient;
        try {
            ingredient = Ingredient.CODEC.parse(ops, json)
                .resultOrPartial(message -> LOGGER.warn("Failed to parse ingredient for {} slot {}: {}", recipeId, slot, message));
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to parse ingredient for {} slot {} ({}: {})",
                recipeId,
                slot,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            ingredient = Optional.empty();
        }
        if (ingredient.isEmpty()) {
            rows.add(new RecipeInputRow(recipeId, slot, role, "custom", null, 1));
            return false;
        }
        return addIngredientRows(recipeId, slot, role, ingredient.get(), rows);
    }

    private static List<RecipeOutputRow> outputRows(HolderLookup.Provider registries, String recipeId, Recipe<?> recipe) {
        if (recipe.getSerializer() == RecipeSerializer.SMITHING_TRIM) {
            return List.of();
        }

        ItemStack result = recipe.getResultItem(registries);
        ResourceLocation itemId = BuiltInRegistries.ITEM.getKey(result.getItem());
        if (result.isEmpty() || result.getItem() == Items.AIR || itemId == null) {
            return List.of();
        }

        return List.of(new RecipeOutputRow(
            recipeId,
            0,
            itemId.toString(),
            Math.max(1, result.getCount()),
            encodeComponentsPatch(registries, result.getComponentsPatch(), recipeId),
            true
        ));
    }

    private static Optional<JsonElement> encodeRecipe(RegistryOps<JsonElement> ops, Recipe<?> recipe, String recipeId) {
        try {
            return Recipe.CODEC.encodeStart(ops, recipe)
                .resultOrPartial(message -> LOGGER.warn("Failed to encode recipe {}: {}", recipeId, message));
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to encode recipe {} ({}: {}); marking recipe unparsed",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            return Optional.empty();
        }
    }

    private static String encodeComponentsPatch(
        HolderLookup.Provider registries,
        DataComponentPatch patch,
        String recipeId
    ) {
        if (patch.isEmpty()) {
            return null;
        }

        RegistryOps<JsonElement> ops = registries.createSerializationContext(JsonOps.INSTANCE);
        Optional<JsonElement> encoded = DataComponentPatch.CODEC.encodeStart(ops, patch)
            .resultOrPartial(message -> LOGGER.warn("Failed to encode output components for {}: {}", recipeId, message));
        return encoded.map(RecipeSource::canonicalJson).orElse(null);
    }

    private static String recipeTypeId(Recipe<?> recipe) {
        ResourceLocation typeId = BuiltInRegistries.RECIPE_TYPE.getKey(recipe.getType());
        return typeId == null ? recipe.getType().toString() : typeId.toString();
    }

    private static String safeRecipeTypeId(Recipe<?> recipe, String recipeId) {
        try {
            return recipeTypeId(recipe);
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to read recipe type for {} ({}: {})",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            return "unknown";
        }
    }

    private static boolean safeIsSpecial(Recipe<?> recipe, String recipeId) {
        try {
            return recipe.isSpecial();
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to read recipe special flag for {} ({}: {}); marking recipe unparsed",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            return true;
        }
    }

    private static String safeGroup(Recipe<?> recipe, String recipeId) {
        try {
            return blankToNull(recipe.getGroup());
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to read recipe group for {} ({}: {})",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
            return null;
        }
    }

    private static MaterializedRecipe unparsedRecipe(RecipeHolder<?> holder, RuntimeException exception) {
        String recipeId = holder.id().toString();
        String typeId = safeRecipeTypeId(holder.value(), recipeId);
        LOGGER.warn("Failed to materialize recipe {} ({}: {}); exporting unparsed row only",
            recipeId,
            exception.getClass().getSimpleName(),
            exception.getMessage());
        int[] gridSize = safeGridSize(holder.value(), recipeId);
        RecipeRow row = new RecipeRow(
            recipeId,
            typeId,
            holder.id().getNamespace(),
            sha256(recipeId + "\n" + typeId + "\nunparsed"),
            null,
            true,
            null,
            gridSize == null ? null : gridSize[0],
            gridSize == null ? null : gridSize[1]
        );
        return new MaterializedRecipe(row, List.of(), List.of());
    }

    /** 有序合成的网格宽高（行主序槽位 = row * width + col）；非有序配方返回 null。 */
    private static int[] safeGridSize(Recipe<?> recipe, String recipeId) {
        try {
            if (recipe instanceof ShapedRecipe shaped) {
                return new int[] { shaped.getWidth(), shaped.getHeight() };
            }
        } catch (RuntimeException exception) {
            LOGGER.warn("Failed to read shaped grid size for {} ({}: {})",
                recipeId,
                exception.getClass().getSimpleName(),
                exception.getMessage());
        }
        return null;
    }

    private static boolean isFluidIngredientJson(JsonElement json) {
        if (!(json instanceof JsonObject object)) {
            return false;
        }
        if (object.has("fluid") || object.has("fluids")) {
            return true;
        }
        if (!object.has("amount")) {
            return false;
        }

        String type = stringProperty(object, "type");
        return ("neoforge:single".equals(type) || "neoforge:tag".equals(type) || "neoforge:components".equals(type))
            && object.has("tag");
    }

    private static String stringProperty(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value == null || !value.isJsonPrimitive() ? null : value.getAsString();
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

    private static String sha256(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private record MaterializedRecipe(
        RecipeRow recipe,
        List<RecipeInputRow> inputs,
        List<RecipeOutputRow> outputs
    ) {}
}
