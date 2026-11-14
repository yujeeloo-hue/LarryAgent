import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fileExtensionOf,
  isImagePath,
  isProbablyBinaryPath,
  languageForPath,
} from "./languages.js";

describe("languageForPath", () => {
  it("maps the 8 confirmed languages", () => {
    assert.deepEqual(languageForPath("src/App.cs"), {
      languageId: "csharp",
      icon: "csharp",
    });
    assert.equal(languageForPath("main.py").languageId, "python");
    assert.equal(languageForPath("View.swift").languageId, "swift");
    assert.equal(languageForPath("app.js").languageId, "javascript");
    assert.equal(languageForPath("app.ts").languageId, "typescript");
    assert.equal(languageForPath("style.css").languageId, "css");
    assert.equal(languageForPath("index.html").languageId, "html");
    assert.equal(languageForPath("core.cpp").languageId, "cpp");
  });

  it("routes .c/.h to the shared cpp tokenizer (decided)", () => {
    assert.equal(languageForPath("legacy.c").languageId, "cpp");
    assert.equal(languageForPath("header.h").languageId, "cpp");
    assert.equal(languageForPath("module.cc").languageId, "cpp");
  });

  it("maps xml-flavoured project files", () => {
    assert.equal(languageForPath("MyApp.csproj").languageId, "xml");
    assert.equal(languageForPath("App.config").languageId, "xml");
    assert.equal(languageForPath("MainWindow.xaml").languageId, "xml");
    assert.equal(languageForPath("logo.svg").languageId, "xml");
  });

  it("gives .txt its own TX badge key but keeps plaintext", () => {
    assert.deepEqual(languageForPath("notes.txt"), {
      languageId: "plaintext",
      icon: "txt",
    });
  });

  it("falls back to plaintext for unknown extensions and no extension", () => {
    assert.equal(languageForPath("data.unknownext").languageId, "plaintext");
    assert.equal(languageForPath("LICENSE").languageId, "plaintext");
    assert.equal(languageForPath("LICENSE").icon, "text");
  });

  it("is case-insensitive on extensions", () => {
    assert.equal(languageForPath("SRC/APP.CS").languageId, "csharp");
    assert.equal(languageForPath("Native\\Shell.VCXPROJ").languageId, "xml");
  });
});

describe("isProbablyBinaryPath", () => {
  it("flags binaries the editor must not open", () => {
    assert.ok(isProbablyBinaryPath("assets/logo.png"));
    assert.ok(isProbablyBinaryPath("bin/Debug/App.dll"));
    assert.ok(isProbablyBinaryPath("docs/manual.pdf"));
    assert.ok(isProbablyBinaryPath("cert/server.pfx"));
  });

  it("keeps text editable", () => {
    assert.ok(!isProbablyBinaryPath("src/App.cs"));
    assert.ok(!isProbablyBinaryPath("README.md"));
    assert.ok(!isProbablyBinaryPath("makefile"));
  });
});

describe("isImagePath", () => {
  it("flags images the File Reader renders", () => {
    assert.ok(isImagePath("assets/shot.png"));
    assert.ok(isImagePath("imgs\\photo.JPG"));
    assert.ok(isImagePath("docs/diagram.webp"));
    assert.ok(isImagePath("icons/favicon.ico"));
  });

  it("keeps editor-bound and reader-code files out", () => {
    assert.ok(!isImagePath("src/App.cpp"));
    assert.ok(!isImagePath("README.md"));
    assert.ok(!isImagePath("manual.pdf"));
    assert.ok(!isImagePath("scan.tiff"));
  });
});

describe("fileExtensionOf", () => {
  it("handles both separators and dotless names", () => {
    assert.equal(fileExtensionOf("a/b/c.ts"), "ts");
    assert.equal(fileExtensionOf("C:\\x\\y.CSPROJ"), "csproj");
    assert.equal(fileExtensionOf("Makefile"), "");
    assert.equal(fileExtensionOf(".gitignore"), "gitignore");
  });
});
