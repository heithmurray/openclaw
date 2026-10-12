import { readJsonObjectMembers } from "../../infra/json-object-members.js";

// SQLite's decimal conversion retains a uint64 mantissa, then uses normalized
// powers of ten. Keep that rounding here: Number(raw) differs past 19 digits.
function sqliteReal(raw: string): number {
  const [coefficient, exponent = "0"] = raw.toLowerCase().split("e");
  const [integer, fraction = ""] = coefficient!.replace("-", "").split(".");
  const limit = (2n ** 64n - 10n) / 10n;
  let mantissa = 0n;
  let scale =
    exponent.replace(/^[+-]?0*/u, "").length > 5
      ? exponent.startsWith("-")
        ? -10000
        : 10000
      : Number(exponent);
  for (const digit of integer!) {
    if (mantissa >= limit) {
      scale++;
    } else {
      mantissa = mantissa * 10n + BigInt(digit);
    }
  }
  for (const digit of fraction) {
    if (mantissa < limit) {
      mantissa = mantissa * 10n + BigInt(digit);
      scale--;
    }
  }
  return Number(`${raw.startsWith("-") ? "-" : ""}${mantissa}e${scale}`);
}

function normalizedPowerOfTen(power: number, round = true): bigint {
  const shift = 95 - ((power * 108853) >> 15);
  const numerator = power >= 0 ? 10n ** BigInt(power) : 1n;
  const denominator = power >= 0 ? 1n : 10n ** BigInt(-power);
  const top = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const bottom = shift >= 0 ? denominator : denominator << BigInt(-shift);
  return (top + (round ? bottom / 2n : 0n)) / bottom;
}

function powerOfTenHigh(power: number): bigint {
  if ((power >= 0 && power < 27) || power === -1) {
    return normalizedPowerOfTen(power, power !== -1) >> 32n;
  }
  const group = Math.floor(power / 27);
  const base = normalizedPowerOfTen(power - group * 27) >> 32n;
  let product = (normalizedPowerOfTen(group * 27) * base) >> 64n;
  if (product < 1n << 95n) {
    product = (product << 1n) | 1n;
  }
  return product >> 32n;
}

/** SQLite's %!.17g spelling, including its round-trip shortening rules. */
function sqliteRealText(value: number): string {
  if (!Number.isFinite(value)) {
    return value < 0 ? "-Inf" : "Inf";
  }
  if (value === 0) {
    return "0.0";
  }
  const magnitude = Math.abs(value);
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, magnitude);
  const bits = bytes.getBigUint64(0);
  let exponent = Number((bits >> 52n) & 2047n);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (exponent === 0) {
    const shift = 64 - mantissa.toString(2).length;
    mantissa <<= BigInt(shift);
    exponent = -1074 - shift;
  } else {
    mantissa = (mantissa << 11n) | (1n << 63n);
    exponent -= 1086;
  }
  const power = 17 - (((exponent + 63) * 78913) >> 18);
  let high = (mantissa * powerOfTenHigh(power)) >> 64n;
  high >>= BigInt(-(exponent + ((power * 108853) >> 15) + 2));
  let digits = ((high + ((high << 1n) & 2n)) >> 1n).toString();
  let decimalExponent = digits.length - 1 - power;
  let precision = 17;
  if (digits[15] === "9" && digits[14] === "9") {
    let end = 14;
    while (end > 0 && digits[end - 1] === "9") {
      end--;
    }
    const rounded = end === 0 ? 1n : BigInt(digits.slice(0, end)) + 1n;
    if (Number(`${rounded}e${decimalExponent - end + 1}`) === magnitude) {
      precision = end + 1;
    }
  } else if (
    decimalExponent + 1 >= digits.length ||
    (digits[15] === "0" && digits[14] === "0" && digits[13] === "0")
  ) {
    let end = 13;
    while (end > 0 && digits[end - 1] === "0") {
      end--;
    }
    if (Number(`${digits.slice(0, end)}e${decimalExponent - end + 1}`) === magnitude) {
      precision = end + 1;
    }
  }
  digits = (BigInt(digits.slice(0, precision)) + (digits[precision]! >= "5" ? 1n : 0n)).toString();
  if (digits.length > precision) {
    decimalExponent++;
  }
  digits = digits.replace(/0+$/u, "");
  const sign = value < 0 ? "-" : "";
  if (decimalExponent < -4 || decimalExponent >= 17) {
    return `${sign}${digits[0]}.${digits.slice(1) || "0"}e${decimalExponent < 0 ? "-" : "+"}${String(Math.abs(decimalExponent)).padStart(2, "0")}`;
  }
  const point = decimalExponent + 1;
  return (
    sign +
    (point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}.0`
        : `${digits.slice(0, point)}.${digits.slice(point)}`)
  );
}

function identityFields(identityJson: string | null): Map<string, string> {
  try {
    const json = identityJson?.toWellFormed() ?? null;
    let depth = 0;
    for (const [token] of json?.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]]/gu) ?? []) {
      if ((token === "{" || token === "[") && ++depth > 1000) {
        return new Map();
      }
      if (token === "}" || token === "]") {
        depth--;
      }
    }
    return json === null ? new Map() : readJsonObjectMembers(json);
  } catch {
    return new Map();
  }
}

function resumeText(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null") {
    return null;
  }
  if (raw.startsWith('"')) {
    // JSON1 encodes lone UTF-16 surrogates as three invalid UTF-8 bytes.
    return (JSON.parse(raw) as string)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "���")
      .trim();
  }
  if (raw === "true" || raw === "false") {
    return raw === "true" ? "1" : "0";
  }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    return raw;
  }
  if (/^-?\d+$/u.test(raw)) {
    const integer = BigInt(raw);
    if (integer >= -(2n ** 63n) && integer < 2n ** 63n) {
      return integer.toString();
    }
  }
  return sqliteRealText(sqliteReal(raw));
}

export function deriveAcpResumeColumns(identityJson: string | null) {
  const fields = identityFields(identityJson);
  return {
    resume_agent_session_id: resumeText(fields.get("agentSessionId")),
    resume_acpx_session_id: resumeText(fields.get("acpxSessionId")),
  };
}

/** Promoted indexes include scalars; resume has always admitted only JSON strings. */
export function matchesAcpResumeIdentity(identityJson: string | null, resumeId: string): boolean {
  const fields = identityFields(identityJson);
  return [fields.get("agentSessionId"), fields.get("acpxSessionId")].some(
    (raw) => raw?.startsWith('"') && resumeText(raw) === resumeId,
  );
}
