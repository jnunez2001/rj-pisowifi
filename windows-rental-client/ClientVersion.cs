namespace StarkFiRentalClient;

// This client's own analog of the ESP8266 vendo firmware's FIRMWARE_VERSION
// define, plus a C# port of that firmware's parseFwVersion/isNewerVersion
// logic (esp8266/firmware/rj_pisowifi_esp8266/ota.cpp). Same reasoning as
// that file documents: a same-or-older version must never trigger an
// update, and malformed input degrades to 0.0.0 rather than to garbage - a
// version check that quietly fails is much safer than one that quietly
// replaces the running exe with the wrong thing.
public static class ClientVersion
{
    public const string Current = "v1.0.0";

    private readonly struct FwVersion
    {
        public readonly int Major, Minor, Patch;
        public FwVersion(int major, int minor, int patch) { Major = major; Minor = minor; Patch = patch; }
    }

    private static FwVersion Parse(string? raw)
    {
        var s = raw ?? "";
        if (s.StartsWith("v") || s.StartsWith("V")) s = s.Substring(1);

        var firstDot = s.IndexOf('.');
        if (firstDot < 0) return new FwVersion(ParseIntSafe(s), 0, 0);

        var secondDot = s.IndexOf('.', firstDot + 1);
        var major = ParseIntSafe(s.Substring(0, firstDot));
        if (secondDot < 0) return new FwVersion(major, ParseIntSafe(s.Substring(firstDot + 1)), 0);

        var minor = ParseIntSafe(s.Substring(firstDot + 1, secondDot - firstDot - 1));
        var patch = ParseIntSafe(s.Substring(secondDot + 1));
        return new FwVersion(major, minor, patch);
    }

    private static int ParseIntSafe(string s)
    {
        // Mirrors Arduino String::toInt(): parse a leading run of digits,
        // 0 for anything that isn't a valid number - never throws.
        var digits = "";
        foreach (var c in s.Trim())
        {
            if (char.IsDigit(c) || (digits.Length == 0 && c == '-')) digits += c;
            else break;
        }
        return int.TryParse(digits, out var value) ? value : 0;
    }

    // True only when candidateVersion numerically outranks currentVersion -
    // same-or-older (including malformed/empty input on either side, which
    // degrades to 0.0.0) always returns false, never a false positive.
    public static bool IsNewerVersion(string? candidateVersion, string? currentVersion)
    {
        var candidate = Parse(candidateVersion);
        var current = Parse(currentVersion);
        if (candidate.Major != current.Major) return candidate.Major > current.Major;
        if (candidate.Minor != current.Minor) return candidate.Minor > current.Minor;
        return candidate.Patch > current.Patch;
    }
}
