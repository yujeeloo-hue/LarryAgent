/**
 * Pure .sln parser tests — fixture mirrors a real VS/Rider solution with
 * BOM + CRLF, solution folders (incl. nested folder), SolutionItems and a
 * NestedProjects section.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSlnTree, parseSln } from "./slnParser.js";

const FOLDER_GUID = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";
const CSHARP_CLASSIC = "{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}";
const CSHARP_SDK = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";
const CPP_GUID = "{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}";

const SAMPLE = [
  "\uFEFFMicrosoft Visual Studio Solution File, Format Version 12.00",
  "# Visual Studio Version 17",
  "VisualStudioVersion = 17.9.34714.143",
  "MinimumVisualStudioVersion = 10.0.40219.1",
  `Project("${FOLDER_GUID}") = "Solution Items", "Solution Items", "{11111111-1111-1111-1111-111111111111}"`,
  "\tProjectSection(SolutionItems) = preProject",
  "\t\tfile = README.md",
  "\t\tfile = .gitignore",
  "\t\tfile = docs\\architecture.md",
  "\tEndProjectSection",
  "EndProject",
  `Project("${FOLDER_GUID}") = "Apps", "Apps", "{22222222-2222-2222-2222-222222222222}"`,
  "EndProject",
  `Project("${FOLDER_GUID}") = "Core", "Core", "{33333333-3333-3333-3333-333333333333}"`,
  "EndProject",
  `Project("${CSHARP_CLASSIC}") = "App.Web", "src\\App.Web\\App.Web.csproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
  "EndProject",
  `Project("${CSHARP_SDK}") = "Core.Lib", "src\\Core.Lib\\Core.Lib.csproj", "{AAAAAAAA-0000-0000-0000-000000000002}"`,
  "EndProject",
  `Project("${CPP_GUID}") = "Native.Shell", "native\\Native.Shell\\Native.Shell.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000003}"`,
  "EndProject",
  `Project("${CSHARP_SDK}") = "Root.Tests", "tests\\Root.Tests\\Root.Tests.csproj", "{AAAAAAAA-0000-0000-0000-000000000004}"`,
  "EndProject",
  "Global",
  "\tGlobalSection(SolutionConfigurationPlatforms) = preSolution",
  "\t\tDebug|Any CPU = Debug|Any CPU",
  "\t\tRelease|Any CPU = Release|Any CPU",
  "\tEndGlobalSection",
  "\tGlobalSection(NestedProjects) = preSolution",
  "\t\t{AAAAAAAA-0000-0000-0000-000000000001} = {22222222-2222-2222-2222-222222222222}",
  "\t\t{aaaaaaaa-0000-0000-0000-000000000002} = {33333333-3333-3333-3333-333333333333}",
  "\t\t{33333333-3333-3333-3333-333333333333} = {22222222-2222-2222-2222-222222222222}",
  "\tEndGlobalSection",
  "EndGlobal",
].join("\r\n");

describe("parseSln", () => {
  it("parses projects and folders with normalized guids", () => {
    const sln = parseSln(SAMPLE);
    assert.equal(sln.projects.length, 7);

    const web = sln.projects.find((p) => p.name === "App.Web");
    assert.ok(web);
    assert.equal(web.kind, "project");
    assert.equal(web.guid, "AAAAAAAA-0000-0000-0000-000000000001");
    assert.equal(web.typeGuid, "FAE04EC0-301F-11D3-BF4B-00C04F79EFBC");
    assert.equal(web.path, "src\\App.Web\\App.Web.csproj");

    const items = sln.projects.find((p) => p.name === "Solution Items");
    assert.ok(items);
    assert.equal(items.kind, "folder");
    assert.deepEqual(items.solutionItems, [
      "README.md",
      ".gitignore",
      "docs\\architecture.md",
    ]);
  });

  it("strips the BOM (header line still parses)", () => {
    const withBom = parseSln(SAMPLE);
    assert.ok(withBom.projects.length > 0);
  });

  it("collects nesting with case-normalized guids", () => {
    const sln = parseSln(SAMPLE);
    assert.equal(
      sln.nesting.get("AAAAAAAA-0000-0000-0000-000000000001"),
      "22222222-2222-2222-2222-222222222222",
    );
    // lowercase input guid normalizes to the same key
    assert.equal(
      sln.nesting.get("AAAAAAAA-0000-0000-0000-000000000002"),
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("returns empty result for non-sln text", () => {
    const sln = parseSln("just some text\nnot a solution\n");
    assert.equal(sln.projects.length, 0);
    assert.equal(sln.nesting.size, 0);
  });
});

describe("buildSlnTree", () => {
  it("nests projects under folders and folders under folders, root order = file order", () => {
    const sln = parseSln(SAMPLE);
    const roots = buildSlnTree(sln);
    assert.deepEqual(
      roots.map((n) => n.name),
      ["Solution Items", "Apps", "Native.Shell", "Root.Tests"],
    );

    const apps = roots.find((n) => n.name === "Apps");
    assert.ok(apps);
    // Children sorted by .sln appearance order (VS semantics).
    assert.deepEqual(
      apps.children.map((n) => n.name),
      ["Core", "App.Web"],
    );
    const core = apps.children[0]!;
    assert.equal(core.children.length, 1);
    assert.equal(core.children[0]!.name, "Core.Lib");
    assert.equal(
      core.children[0]!.project?.path,
      "src\\Core.Lib\\Core.Lib.csproj",
    );
  });

  it("ignores nesting into non-folder nodes and missing parents", () => {
    const sln = parseSln(
      [
        `Project("${CSHARP_SDK}") = "A", "a.csproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
        "EndProject",
        `Project("${CSHARP_SDK}") = "B", "b.csproj", "{AAAAAAAA-0000-0000-0000-000000000002}"`,
        "EndProject",
        `Project("${CSHARP_SDK}") = "C", "c.csproj", "{AAAAAAAA-0000-0000-0000-000000000003}"`,
        "EndProject",
        "Global",
        "\tGlobalSection(NestedProjects) = preSolution",
        // project→project nesting: ignored (parent not a folder)
        "\t\t{AAAAAAAA-0000-0000-0000-000000000002} = {AAAAAAAA-0000-0000-0000-000000000001}",
        // missing parent guid: ignored
        "\t\t{AAAAAAAA-0000-0000-0000-000000000003} = {DEADBEEF-0000-0000-0000-000000000009}",
        "\tEndGlobalSection",
        "EndGlobal",
      ].join("\n"),
    );
    const roots = buildSlnTree(sln);
    assert.equal(roots.length, 3);
  });

  it("ignores self-nesting cycles", () => {
    const sln = parseSln(
      [
        `Project("${FOLDER_GUID}") = "F", "F", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
        "EndProject",
        "Global",
        "\tGlobalSection(NestedProjects) = preSolution",
        "\t\t{AAAAAAAA-0000-0000-0000-000000000001} = {AAAAAAAA-0000-0000-0000-000000000001}",
        "\tEndGlobalSection",
        "EndGlobal",
      ].join("\n"),
    );
    const roots = buildSlnTree(sln);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.children.length, 0);
  });
});
