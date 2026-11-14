/**
 * Pure msbuildProjectParser tests — fixture mirrors a UBT-generated vcxproj
 * (paths relative to Intermediate/ProjectFiles, headers under ClCompile,
 * UnrealBuildTool markers) plus a classic csproj and an SDK-style csproj.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeXmlEntities, parseMsBuildProject } from "./msbuildProjectParser.js";

const VCPROJ_UE = [
  "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
  "<Project DefaultTargets=\"Build\" ToolsVersion=\"17.0\" xmlns=\"http://schemas.microsoft.com/developer/msbuild/2003\">",
  "  <PropertyGroup Label=\"Globals\">",
  "    <ProjectGuid>{AAAAAAAA-0000-0000-0000-000000000001}</ProjectGuid>",
  "    <RootNamespace>NF</RootNamespace>",
  "  </PropertyGroup>",
  "  <!-- UnrealBuildTool -->",
  "  <ItemGroup>",
  "    <ClCompile Include=\"..\\..\\Source\\NF\\NFGameModeBase.cpp\" />",
  "    <ClCompile Include=\"..\\..\\Source\\NF\\NFGameModeBase.h\" />",
  "    <ClCompile Include=\"..\\..\\Source\\NF\\Private\\Foo.cpp\" />",
  "    <ClInclude Include=\"..\\..\\Source\\NF\\Public\\Foo.h\" />",
  "    <None Include=\"..\\..\\NF.uproject\" />",
  "    <None Include=\"..\\..\\Source\\NF.Target.cs\" />",
  "  </ItemGroup>",
  "  <ItemGroup>",
  "    <Filter Include=\"Source\">",
  "      <UniqueIdentifier>{deadbeef-0000-0000-0000-000000000000}</UniqueIdentifier>",
  "    </Filter>",
  "  </ItemGroup>",
  "  <ItemGroup>",
  "    <ProjectReference Include=\"..\\UE4\\UE4.vcxproj\">",
  "      <Project>{eeeeeeee-0000-0000-0000-000000000001}</Project>",
  "    </ProjectReference>",
  "  </ItemGroup>",
  "</Project>",
].join("\r\n");

const CSPROJ_CLASSIC = [
  "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
  "<Project ToolsVersion=\"15.0\" xmlns=\"http://schemas.microsoft.com/developer/msbuild/2003\">",
  "  <ItemGroup>",
  "    <Compile Include=\"Program.cs\" />",
  "    <Compile Include=\"Properties\\AssemblyInfo.cs\" />",
  "    <None Include=\"app.config\" />",
  "  </ItemGroup>",
  "</Project>",
].join("\r\n");

const CSPROJ_SDK = [
  "<Project Sdk=\"Microsoft.NET.Sdk\">",
  "  <ItemGroup>",
  "    <Compile Remove=\"obj\\**\" />",
  "    <None Include=\"README.md\" />",
  "  </ItemGroup>",
  "</Project>",
].join("\n");

describe("parseMsBuildProject", () => {
  it("extracts file items with tags, deduped, doc order", () => {
    const info = parseMsBuildProject(VCPROJ_UE);
    assert.equal(info.items.length, 6);
    assert.deepEqual(info.items.map((i) => i.tag), [
      "ClCompile",
      "ClCompile",
      "ClCompile",
      "ClInclude",
      "None",
      "None",
    ]);
    assert.equal(info.items[0]?.include, "..\\..\\Source\\NF\\NFGameModeBase.cpp");
  });

  it("ignores references, filters and attribute-less tags", () => {
    const info = parseMsBuildProject(VCPROJ_UE);
    const tags = new Set(info.items.map((i) => i.tag));
    assert.ok(!tags.has("Filter"));
    assert.ok(!tags.has("ProjectReference"));
  });

  it("dedupes by normalized path across ItemGroups", () => {
    const info = parseMsBuildProject([
      "<Project>",
      "  <ItemGroup>",
      "    <ClCompile Include=\"a\\b.cpp\" />",
      "    <ClCompile Include=\"a/b.cpp\" />",
      "  </ItemGroup>",
      "</Project>",
    ].join("\n"));
    assert.equal(info.items.length, 1);
  });

  it("flags UBT-generated vcxproj", () => {
    assert.equal(parseMsBuildProject(VCPROJ_UE).unrealGenerated, true);
    assert.equal(parseMsBuildProject(CSPROJ_CLASSIC).unrealGenerated, false);
  });

  it("flags SDK-style and not classic vcxproj/csproj", () => {
    assert.equal(parseMsBuildProject(VCPROJ_UE).sdkStyle, false);
    assert.equal(parseMsBuildProject(CSPROJ_CLASSIC).sdkStyle, false);
    assert.equal(parseMsBuildProject(CSPROJ_SDK).sdkStyle, true);
  });

  it("decodes xml entities in includes", () => {
    const info = parseMsBuildProject(
      "<Project><ItemGroup><None Include=\"a&amp;b.txt\" /><None Include=\"c&quot;d.cs\" /></ItemGroup></Project>",
    );
    assert.deepEqual(info.items.map((i) => i.include), ["a&b.txt", 'c"d.cs']);
  });

  it("tolerates BOM and garbage input", () => {
    assert.deepEqual(parseMsBuildProject("\uFEFF<Project></Project>"), {
      items: [],
      sdkStyle: false,
      unrealGenerated: false,
    });
    const junk = parseMsBuildProject("this is not xml at all <<<<");
    assert.equal(junk.items.length, 0);
    assert.equal(junk.sdkStyle, false);
  });

  it("handles large payloads without pathological behavior (5MB-scale)", () => {
    // ~9k items x ~80 bytes ≈ 720KB of tag text; pad to 5MB-scale with comments.
    const chunk = [
      "  <ItemGroup>",
      ...Array.from({ length: 9000 }, (_, i) => `    <ClCompile Include="..\\..\\Source\\Mod${i}\\File${i}.cpp" />`),
      "  </ItemGroup>",
    ].join("\r\n");
    const pad = "<!-- " + "x".repeat(1024) + " -->";
    const big = "<Project>" + pad.repeat(5000) + chunk + "</Project>";
    assert.ok(big.length > 5_000_000);
    const info = parseMsBuildProject(big);
    assert.equal(info.items.length, 9000);
  });
});

describe("decodeXmlEntities", () => {
  it("leaves plain paths alone", () => {
    assert.equal(decodeXmlEntities("a\\b\\c.cpp"), "a\\b\\c.cpp");
  });
  it("decodes amp last so pre-encoded entities stay intact", () => {
    // "&amp;lt;" is the escaped form of the literal text "&lt;" — one pass
    // must not double-decode it into "<".
    assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  });
});
