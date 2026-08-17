package io.github.aeroseira.mpide_exporter.source;

import net.neoforged.fml.ModList;
import net.neoforged.neoforgespi.language.IModInfo;

import java.util.Comparator;
import java.util.List;

/** Captures the loaded mod list into rows for the {@code mods} table. */
public final class ModListSource {

    private ModListSource() {}

    public record ModRow(String modid, String version, String name) {}

    public static List<ModRow> capture() {
        return ModList.get().getMods().stream()
            .map(ModListSource::toRow)
            .sorted(Comparator.comparing(ModRow::modid))
            .toList();
    }

    private static ModRow toRow(IModInfo info) {
        return new ModRow(
            info.getModId(),
            info.getVersion() == null ? null : info.getVersion().toString(),
            blankToNull(info.getDisplayName())
        );
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
