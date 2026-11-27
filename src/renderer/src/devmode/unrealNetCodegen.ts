
import {
  detectEol,
  detectIndentUnit,
  endOfLine,
  hasLifetimeRegistration,
  lineIndent,
  maskCpp,
  mentionsDeclaration,
  offsetOfLine,
  positionAt,
  scanImplBodies,
  scanUnrealClass,
  stripDefaultArgs,
  isScalarType,
  hasSpecifier,
  type UeClassScan,
  type UeReflectionMember,
} from "./unrealNetScan.js";

export type NetCodegenEdit = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
};

export type NetCodegenFilePlan = {
  path: string;
  edits: NetCodegenEdit[];
};

export type NetCodegenSummary = {
  created: string[];
  alreadyPresent: string[];
  skipped: string[];
};

export type NetCodegenPlan = {
  files: NetCodegenFilePlan[];
  summary: NetCodegenSummary;
  advisories: string[];
  unchanged: boolean;
};

export type NetCodegenInput = {
  headerPath: string;
  headerText: string;
  sourcePath: string | null;
  sourceText: string | null;
  caretHeaderLine?: number;
  scope: "class" | "member";
  pushModel: boolean;
};

type Insertion = { offset: number; order: number; text: string };

const GET_LIFETIME_SIGNATURE =
  "virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;";

const ACCESS_LINE_RE = /^\s*(public|private|protected)\s*(?:slots)?\s*:/;

function pushInsertion(
  list: Insertion[],
  offset: number,
  order: number,
  text: string,
): void {
  list.push({ offset, order, text });
}

function mergeEdits(text: string, insertions: Insertion[]): NetCodegenEdit[] {
  if (insertions.length === 0) return [];
  const sorted = [...insertions].sort(
    (a, b) => a.offset - b.offset || a.order - b.order,
  );
  const merged: { offset: number; text: string }[] = [];
  for (const insertion of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.offset === insertion.offset) {
      last.text += insertion.text;
      continue;
    }
    merged.push({ offset: insertion.offset, text: insertion.text });
  }
  return merged.map((entry) => {
    const pos = positionAt(text, entry.offset);
    return {
      startLine: pos.line,
      startColumn: pos.column,
      endLine: pos.line,
      endColumn: pos.column,
      text: entry.text,
    };
  });
}

function accessLabelIndent(headerText: string, scan: UeClassScan): string {
  for (let line = scan.bodyOpenLine + 1; line < scan.bodyCloseLine; line++) {
    const text = headerText.slice(
      offsetOfLine(headerText, line),
      endOfLine(headerText, line),
    );
    if (ACCESS_LINE_RE.test(text)) return lineIndent(headerText, line);
  }
  return "";
}

function lastAccessInBody(
  headerText: string,
  scan: UeClassScan,
): "public" | "private" | "protected" {
  let access: "public" | "private" | "protected" =
    scan.kind === "struct" ? "public" : "private";
  for (let line = scan.bodyOpenLine + 1; line < scan.bodyCloseLine; line++) {
    const text = headerText.slice(
      offsetOfLine(headerText, line),
      endOfLine(headerText, line),
    );
    const m = ACCESS_LINE_RE.exec(text);
    if (m) access = m[1] as "public" | "private" | "protected";
  }
  return access;
}

function rpcImplName(member: UeReflectionMember, kind: string): string {
  const override = member.values[kind];
  const bare = override?.match(/[A-Za-z_]\w*/)?.[0];
  return bare ?? `${member.name}_Implementation`;
}

function rpcValidationName(member: UeReflectionMember): string {
  const override = member.values["withvalidation"];
  const bare = override?.match(/[A-Za-z_]\w*/)?.[0];
  return bare ?? `${member.name}_Validate`;
}

function rpcKindOf(member: UeReflectionMember): "server" | "client" | "multicast" | null {
  if (hasSpecifier(member, "server")) return "server";
  if (hasSpecifier(member, "client")) return "client";
  if (hasSpecifier(member, "netmulticast")) return "multicast";
  return null;
}

function baseLooksNetworked(scan: UeClassScan): boolean {
  if (scan.bases.length === 0) return false;
  if (scan.bases.every((base) => base === "UObject")) return false;
  return scan.bases.some(
    (base) => /^A[A-Z]/.test(base) || /Component$/.test(base),
  );
}

function networkCapable(scan: UeClassScan): "yes" | "no" | "unknown" {
  if (scan.kind === "struct") return "no";
  if (baseLooksNetworked(scan)) return "yes";
  if (scan.bases.length === 0 || scan.bases.every((base) => base === "UObject")) {
    return "no";
  }
  return "unknown";
}

function propRepKind(member: UeReflectionMember): "plain" | "notify" | null {
  if (hasSpecifier(member, "replicatedusing")) return "notify";
  if (hasSpecifier(member, "replicated")) return "plain";
  return null;
}

function onRepName(member: UeReflectionMember): string | null {
  const raw = member.values["replicatedusing"];
  if (!raw) return null;
  return raw.match(/[A-Za-z_]\w*/)?.[0] ?? null;
}

function setterNameFor(member: UeReflectionMember): string {
  const explicit = member.values["blueprintsetter"];
  const bare = explicit?.match(/[A-Za-z_]\w*/)?.[0];
  if (bare) return bare;
  return `Set${member.name.replace(/^b(?=[A-Z])/, "")}`;
}

export function planUnrealNetCodegen(input: NetCodegenInput): NetCodegenPlan {
  const summary: NetCodegenSummary = {
    created: [],
    alreadyPresent: [],
    skipped: [],
  };
  const advisories: string[] = [];
  const headerInsertions: Insertion[] = [];
  const sourceInsertions: Insertion[] = [];

  const scan = scanUnrealClass(input.headerText, input.caretHeaderLine);
  if (!scan) {
    advisories.push("No UCLASS / USTRUCT body found in this header.");
    return {
      files: [],
      summary,
      advisories,
      unchanged: true,
    };
  }
  if (!/\bU(?:CLASS|STRUCT)\s*\(/.test(input.headerText)) {
    advisories.push(
      `${scan.className} is not preceded by a UCLASS()/USTRUCT() macro in this header — nothing generated.`,
    );
    return { files: [], summary, advisories, unchanged: true };
  }

  const bodyText = input.headerText.slice(
    scan.bodyStartOffset,
    scan.bodyEndOffset,
  );
  const capability = networkCapable(scan);
  if (capability === "no") {
    advisories.push(
      `${scan.className} does not derive from an Actor / UActorComponent — RPCs and replicated properties do not work there. Nothing generated.`,
    );
    return { files: [], summary, advisories, unchanged: true };
  }
  if (capability === "unknown") {
    advisories.push(
      `Parent of ${scan.className} (${scan.bases.join(", ")}) is not obviously an Actor/UActorComponent — generated code assumes replication is supported.`,
    );
  }

  const eol = detectEol(input.headerText);
  const indentUnit = detectIndentUnit(input.headerText);
  const scopeMember =
    input.scope === "member" && input.caretHeaderLine !== undefined
      ? (scan.members.find(
          (member) =>
            input.caretHeaderLine! >= member.line &&
            input.caretHeaderLine! <= member.endLine,
        ) ?? null)
      : null;
  if (input.scope === "member" && !scopeMember) {
    advisories.push(
      "Caret is not inside a UPROPERTY()/UFUNCTION() declaration — generated for the whole class instead.",
    );
  }

  const members = scopeMember ? [scopeMember] : scan.members;
  const rpcs = members.filter((member) => {
    if (member.macro !== "UFUNCTION") return false;
    if (rpcKindOf(member) !== null) return true;
    return hasSpecifier(member, "blueprintnativeevent");
  });
  const replicated = members.filter(
    (member) => member.macro === "UPROPERTY" && propRepKind(member) !== null,
  );

  if (rpcs.length === 0 && replicated.length === 0) {
    advisories.push(
      `No RPC or replicated property found in ${scan.className} — nothing to generate.`,
    );
    return { files: [], summary, advisories, unchanged: true };
  }

  const sourceText = input.sourceText;
  const sourcePath = input.sourcePath;
  const impls =
    sourceText && sourcePath ? scanImplBodies(sourceText, scan.className) : [];
  const implByName = new Map(impls.map((impl) => [impl.name, impl]));
  const sourceEol = sourceText ? detectEol(sourceText) : eol;
  const sourceIndent = sourceText ? detectIndentUnit(sourceText) : indentUnit;
  const classBodyAccess = lastAccessInBody(input.headerText, scan);

  if (!sourceText || !sourcePath) {
    advisories.push(
      "No counterpart source file found — declarations are generated, definitions are skipped.",
    );
  }


  const headerInsert = (member: UeReflectionMember, lines: string[]): void => {
    const indent = lineIndent(input.headerText, member.line) || indentUnit;
    const offset = offsetOfLine(input.headerText, member.endLine + 1);
    const text = lines
      .map((line) => `${indent}${line}${eol}`)
      .join("");
    pushInsertion(headerInsertions, offset, 10, `${eol}${text}`);
  };

  const needsSource: { label: string; definition: string; order: number }[] = [];
  let definitionOrder = 100;

  for (const member of rpcs) {
    const kind = rpcKindOf(member);
    const isBlueprint = kind === null;
    const implName = isBlueprint
      ? `${member.name}_Implementation`
      : rpcImplName(member, kind!);
    const params = stripDefaultArgs(member.params ?? "");
    const returnType = isBlueprint ? (member.type ?? "void") : "void";

    if (mentionsDeclaration(bodyText, implName)) {
      summary.alreadyPresent.push(`${implName}() declaration`);
    } else {
      headerInsert(member, [
        `virtual ${returnType} ${implName}(${params});`,
      ]);
      summary.created.push(`${implName}() declaration`);
    }

    if (sourceText) {
      if (implByName.has(implName)) {
        summary.alreadyPresent.push(`${implName}() definition`);
      } else {
        needsSource.push({
          label: `${implName}() definition`,
          definition: [
            `${returnType} ${scan.className}::${implName}(${params})`,
            "{",
            "}",
          ].join(sourceEol),
          order: definitionOrder++,
        });
      }
    }

    if (kind !== null && hasSpecifier(member, "withvalidation")) {
      const validateName = rpcValidationName(member);
      if (mentionsDeclaration(bodyText, validateName)) {
        summary.alreadyPresent.push(`${validateName}() declaration`);
      } else {
        headerInsert(member, [`virtual bool ${validateName}(${params});`]);
        summary.created.push(`${validateName}() declaration`);
      }
      if (sourceText) {
        if (implByName.has(validateName)) {
          summary.alreadyPresent.push(`${validateName}() definition`);
        } else {
          needsSource.push({
            label: `${validateName}() definition`,
            definition: [
              `bool ${scan.className}::${validateName}(${params})`,
              "{",
              "\treturn true;",
              "}",
            ].join(sourceEol),
            order: definitionOrder++,
          });
        }
      }
    }
  }


  const repProps: {
    member: UeReflectionMember;
    pushBased: boolean;
  }[] = [];

  for (const member of replicated) {
    const onRep = onRepName(member);
    if (onRep) {
      if (mentionsDeclaration(bodyText, onRep)) {
        summary.alreadyPresent.push(`${onRep}() declaration`);
      } else {
        headerInsert(member, [`UFUNCTION()`, `void ${onRep}();`]);
        summary.created.push(`${onRep}() declaration`);
      }
      if (sourceText) {
        if (implByName.has(onRep)) {
          summary.alreadyPresent.push(`${onRep}() definition`);
        } else {
          needsSource.push({
            label: `${onRep}() definition`,
            definition: [
              `void ${scan.className}::${onRep}()`,
              "{",
              "}",
            ].join(sourceEol),
            order: definitionOrder++,
          });
        }
      }
    }

    let pushBased = false;
    if (input.pushModel) {
      const setter = setterNameFor(member);
      const hasSetter =
        mentionsDeclaration(bodyText, setter) || implByName.has(setter);
      const setterImpl = implByName.get(setter);
      const assignPattern = new RegExp(`\\b${member.name}\\s*=[^=]`, "g");
      const maskedSource = sourceText ? maskCpp(sourceText) : "";
      const assignmentSites = countMatches(
        maskedSource,
        assignPattern,
        setterImpl && sourceText
          ? {
              start: offsetOfLine(sourceText, setterImpl.openLine),
              end: offsetOfLine(sourceText, setterImpl.closeLine + 1),
            }
          : null,
      );
      const fileMarksProp = new RegExp(
        `MARK_PROPERTY_DIRTY\\w*\\s*\\([^)]*\\b${member.name}\\b`,
      ).test(maskedSource);

      if (hasSetter && setterImpl && sourceText) {
        const bodyStart = offsetOfLine(sourceText, setterImpl.openLine + 1);
        const bodyEnd = offsetOfLine(sourceText, setterImpl.closeLine);
        const bodySlice = sourceText.slice(bodyStart, bodyEnd);
        if (bodySlice.includes("MARK_PROPERTY_DIRTY")) {
          summary.alreadyPresent.push(`${member.name} dirty mark`);
          pushBased = true;
        } else {
          const assign = new RegExp(`\\b${member.name}\\s*=[^=]`).exec(bodySlice);
          const semicolon =
            assign === null
              ? -1
              : bodySlice.indexOf(";", assign.index + assign[0].length);
          if (semicolon >= 0) {
            const anchor = bodyStart + semicolon + 1;
            const indent =
              lineIndent(sourceText, positionAt(sourceText, anchor).line) ||
              `${sourceIndent}${sourceIndent}`;
            pushInsertion(
              sourceInsertions,
              anchor,
              20,
              `${sourceEol}${indent}MARK_PROPERTY_DIRTY_FROM_NAME(${scan.className}, ${member.name}, this);`,
            );
            summary.created.push(`${member.name} dirty mark`);
            pushBased = true;
            if (assignmentSites > 0) {
              advisories.push(
                `${member.name} is also assigned directly in ${assignmentSites} place(s) — add MARK_PROPERTY_DIRTY_FROM_NAME there too.`,
              );
            }
          } else {
            if (fileMarksProp) {
              summary.alreadyPresent.push(`${member.name} dirty mark`);
              pushBased = true;
            } else {
              advisories.push(
                `${setter}() has no simple assignment to ${member.name} — add MARK_PROPERTY_DIRTY_FROM_NAME manually.`,
              );
            }
          }
        }
      } else if (hasSetter && assignmentSites === 0) {
        pushBased = true;
        advisories.push(
          `${setter}() is defined in another file — verify it calls MARK_PROPERTY_DIRTY_FROM_NAME(${scan.className}, ${member.name}, this).`,
        );
      } else if (hasSetter) {
        advisories.push(
          `${member.name} is assigned directly in ${assignmentSites} place(s) — registered without push model; add MARK_PROPERTY_DIRTY_FROM_NAME at those sites.`,
        );
      } else if (isScalarType(member.type ?? "") && assignmentSites === 0) {
        pushBased = true;
        headerInsert(member, [`void ${setter}(${member.type} InValue);`]);
        summary.created.push(`${setter}() declaration`);
        if (sourceText) {
          needsSource.push({
            label: `${setter}() definition`,
            definition: [
              `void ${scan.className}::${setter}(${member.type} InValue)`,
              "{",
              `\tif (${member.name} != InValue)`,
              "\t{",
              `\t\t${member.name} = InValue;`,
              `\t\tMARK_PROPERTY_DIRTY_FROM_NAME(${scan.className}, ${member.name}, this);`,
              "\t}",
              "}",
            ].join(sourceEol),
            order: definitionOrder++,
          });
        }
      } else if (assignmentSites > 0) {
        advisories.push(
          `${member.name} is assigned directly in ${assignmentSites} place(s) — registered without push model; add MARK_PROPERTY_DIRTY_FROM_NAME at those sites.`,
        );
      } else {
        advisories.push(
          `${member.name} (${member.type}) has no setter — registered without push model, mark it dirty where it is assigned.`,
        );
      }
    }
    repProps.push({ member, pushBased });
  }


  const lifetimeBodyFromSource = (): string | null => {
    const impl = implByName.get("GetLifetimeReplicatedProps");
    if (!impl || !sourceText) return null;
    const start = offsetOfLine(sourceText, impl.openLine);
    const end = offsetOfLine(sourceText, impl.closeLine + 1);
    return sourceText.slice(start, end);
  };

  const lifetimeInHeader = mentionsDeclaration(bodyText, "GetLifetimeReplicatedProps");
  const lifetimeInSource = implByName.has("GetLifetimeReplicatedProps");
  const lifetimeText = lifetimeBodyFromSource();

  const missingRegistrations = repProps.filter(
    (entry) =>
      !lifetimeText ||
      !hasLifetimeRegistration(
        lifetimeText,
        scan.className,
        entry.member.name,
      ),
  );
  for (const entry of repProps) {
    if (
      lifetimeText &&
      hasLifetimeRegistration(lifetimeText, scan.className, entry.member.name)
    ) {
      summary.alreadyPresent.push(`${entry.member.name} registration`);
    }
  }

  if (!lifetimeInHeader && (repProps.length > 0 || lifetimeInSource)) {
    const label = classBodyAccess === "protected" ? "" : "protected:";
    const labelIndent = accessLabelIndent(input.headerText, scan);
    const lines = label
      ? [`${labelIndent}${label}`, `${labelIndent}${indentUnit}${GET_LIFETIME_SIGNATURE}`]
      : [`${labelIndent}${indentUnit}${GET_LIFETIME_SIGNATURE}`];
    pushInsertion(
      headerInsertions,
      offsetOfLine(input.headerText, scan.bodyCloseLine),
      30,
      `${eol}${lines.join(eol)}${eol}`,
    );
    summary.created.push("GetLifetimeReplicatedProps() declaration");
  }

  if (missingRegistrations.length > 0) {
    if (sourceText && sourcePath) {
      const bodyIndent = sourceIndent;
      const registrationLines = missingRegistrations.map(
        (entry) =>
          entry.pushBased
            ? `DOREPLIFETIME_WITH_PARAMS_FAST(${scan.className}, ${entry.member.name}, Params);`
            : entry.member.staticArray
              ? `DOREPLIFETIME_WITH_PARAMS_FAST_STATIC_ARRAY(${scan.className}, ${entry.member.name}, FDoRepLifetimeParams());`
              : `DOREPLIFETIME(${scan.className}, ${entry.member.name});`,
      );

      if (!lifetimeInSource) {
        const needsPushParams = missingRegistrations.some(
          (entry) => entry.pushBased,
        );
        const lines = [
          `void ${scan.className}::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const`,
          "{",
          "\tSuper::GetLifetimeReplicatedProps(OutLifetimeProps);",
        ];
        if (needsPushParams) {
          lines.push("");
          lines.push("\tFDoRepLifetimeParams Params;");
          lines.push("\tParams.bIsPushBased = true;");
        }
        if (registrationLines.length > 0) lines.push("");
        for (const line of registrationLines) lines.push(`\t${line}`);
        lines.push("}");
        needsSource.push({
          label: "GetLifetimeReplicatedProps() definition",
          definition: lines.join(sourceEol),
          order: 90,
        });
      } else {
        const impl = implByName.get("GetLifetimeReplicatedProps")!;
        const closeOffset = offsetOfLine(sourceText, impl.closeLine);
        const bodyStart = offsetOfLine(sourceText, impl.openLine + 1);
        const bodySlice = sourceText.slice(bodyStart, closeOffset);
        const needsPushParams =
          missingRegistrations.some((entry) => entry.pushBased) &&
          !/FDoRepLifetimeParams\s+\w+\s*;/.test(bodySlice);
        if (needsPushParams) {
          pushInsertion(
            sourceInsertions,
            closeOffset,
            0,
            `${bodyIndent}FDoRepLifetimeParams Params;${sourceEol}${bodyIndent}Params.bIsPushBased = true;${sourceEol}${sourceEol}`,
          );
        }
        const text = registrationLines
          .map((line) => `${bodyIndent}${line}${sourceEol}`)
          .join("");
        pushInsertion(sourceInsertions, closeOffset, 1, text);
        for (const entry of missingRegistrations) {
          summary.created.push(`${entry.member.name} registration`);
        }
      }
    }
  }

  if (input.pushModel && missingRegistrations.some((entry) => entry.pushBased) && sourceText) {
    if (!/#include\s+"Net\/Core\/PushModel\/PushModel\.h"/.test(sourceText)) {
      addInclude(sourceInsertions, sourceText, '"Net/Core/PushModel/PushModel.h"');
      summary.created.push("#include PushModel.h");
    }
  }
  if (
    missingRegistrations.length > 0 &&
    sourceText &&
    !/#include\s+"(?:Net\/UnrealNetwork\.h|UnrealNetwork\.h)"/.test(sourceText)
  ) {
    addInclude(sourceInsertions, sourceText, '"Net/UnrealNetwork.h"');
    summary.created.push("#include Net/UnrealNetwork.h");
  }


  if (sourceText && sourcePath && needsSource.length > 0) {
    const anchorLine = definitionAnchorLine(sourceText, impls);
    const block = needsSource
      .sort((a, b) => a.order - b.order)
      .map((entry) => `${entry.definition}${sourceEol}`)
      .join(sourceEol);
    pushInsertion(
      sourceInsertions,
      offsetOfLine(sourceText, anchorLine),
      5,
      `${sourceEol}${block}`,
    );
    for (const entry of needsSource) summary.created.push(entry.label);
  }

  const files: NetCodegenFilePlan[] = [];
  const headerEdits = mergeEdits(input.headerText, headerInsertions);
  if (headerEdits.length > 0) {
    files.push({ path: input.headerPath, edits: headerEdits });
  }
  if (sourcePath && sourceText) {
    const sourceEdits = mergeEdits(sourceText, sourceInsertions);
    if (sourceEdits.length > 0) files.push({ path: sourcePath, edits: sourceEdits });
  }

  addReplicationAdvisories(input, scan, replicated, advisories);

  return {
    files,
    summary,
    advisories,
    unchanged:
      files.length === 0 &&
      summary.created.length === 0 &&
      summary.skipped.length === 0,
  };
}

function countMatches(
  maskedSource: string,
  pattern: RegExp,
  exclude: { start: number; end: number } | null,
): number {
  let count = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(maskedSource)) !== null) {
    if (exclude && match.index >= exclude.start && match.index < exclude.end) {
      continue;
    }
    count += 1;
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }
  return count;
}

function addInclude(
  insertions: Insertion[],
  sourceText: string,
  target: string,
): void {
  const lines = sourceText.split(/\r?\n/);
  let lastInclude = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#include\b/.test(lines[i]!)) lastInclude = i + 1;
  }
  const eol = detectEol(sourceText);
  const anchorLine = lastInclude > 0 ? lastInclude + 1 : 1;
  const offset = offsetOfLine(sourceText, anchorLine);
  pushInsertion(insertions, offset, 1, `#include ${target}${eol}`);
}

function definitionAnchorLine(
  sourceText: string,
  impls: readonly { closeLine: number }[],
): number {
  if (impls.length > 0) {
    const last = impls.reduce(
      (max, impl) => (impl.closeLine > max ? impl.closeLine : max),
      0,
    );
    return last + 1;
  }
  const lines = sourceText.split(/\r?\n/);
  let lastInclude = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#include\b/.test(lines[i]!)) lastInclude = i + 1;
  }
  return lastInclude > 0 ? lastInclude + 1 : 1;
}

function addReplicationAdvisories(
  input: NetCodegenInput,
  scan: UeClassScan,
  replicated: UeReflectionMember[],
  advisories: string[],
): void {
  if (replicated.length === 0) return;
  if (scan.kind === "struct") {
    advisories.push(
      `${scan.className} is a USTRUCT — struct members cannot be replicated (UHT rejects it).`,
    );
    return;
  }
  const source = input.sourceText;
  if (!source) return;
  const ctorRe = new RegExp(
    `${scan.className}::${scan.className}\\s*\\([^)]*\\)[^{]*\\{`,
  );
  const ctor = ctorRe.exec(source);
  const ctorBody = ctor ? source.slice(ctor.index, ctor.index + 4000) : "";
  const isComponent =
    /Component$/.test(scan.className) ||
    scan.bases.some((base) => /Component$/.test(base));
  if (isComponent) {
    const enabled =
      /SetIsReplicatedByDefault\s*\(\s*true\s*\)/.test(source) ||
      /\bbReplicates\s*=\s*true\b/.test(ctorBody);
    if (!enabled) {
      advisories.push(
        "Component never calls SetIsReplicatedByDefault(true) — its properties will not replicate.",
      );
    }
  } else {
    const enabled =
      /\bbReplicates\s*=\s*true\b/.test(ctorBody) ||
      /SetReplicates\s*\(\s*true\s*\)/.test(ctorBody);
    if (!enabled) {
      advisories.push(
        "Constructor does not set bReplicates = true — actor properties will not replicate.",
      );
    }
  }
}

export function parsePushModelSetting(iniText: string): boolean {
  for (const rawLine of iniText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("//")) continue;
    const m = /^net\.IsPushModelEnabled\s*=\s*(.+)$/i.exec(trimmed);
    if (!m) continue;
    const value = m[1]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  }
  return false;
}
