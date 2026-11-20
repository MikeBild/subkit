import { describe, expect, test } from "bun:test";
import {
  autostartDirectory,
  autostartEntry,
  autostartExecutable,
  quoteDesktopExec,
  startsHidden,
} from "./autostart.ts";

describe("startsHidden", () => {
  test("Windows and Linux start hidden with the flag of the login item", () => {
    expect(
      startsHidden({
        argv: ["C:\\Program Files\\SubKit\\SubKit.exe", "--hidden"],
        platform: "win32",
        openedAtLogin: false,
      }),
    ).toBe(true);
    expect(
      startsHidden({
        argv: ["/opt/SubKit/subkit-desktop"],
        platform: "linux",
        openedAtLogin: false,
      }),
    ).toBe(false);
  });

  test("macOS has no arguments at login and asks the system instead", () => {
    const argv = ["/Applications/SubKit.app/Contents/MacOS/SubKit"];
    expect(startsHidden({ argv, platform: "darwin", openedAtLogin: true })).toBe(true);
    expect(startsHidden({ argv, platform: "darwin", openedAtLogin: false })).toBe(false);
    expect(startsHidden({ argv, platform: "win32", openedAtLogin: true })).toBe(false);
  });

  test("a program path that happens to be the flag does not count", () => {
    expect(startsHidden({ argv: ["--hidden"], platform: "linux", openedAtLogin: false })).toBe(
      false,
    );
  });
});

describe("Linux autostart entry", () => {
  test("starts the app hidden and survives a path with spaces and reserved characters", () => {
    expect(autostartEntry({ name: "SubKit", executable: "/opt/Sub Kit/subkit-desktop" })).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=SubKit",
        'Exec="/opt/Sub Kit/subkit-desktop" --hidden',
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
    expect(quoteDesktopExec('/home/a"b/$HOME/`x`/100%/c\\d')).toBe(
      '"/home/a\\"b/\\$HOME/\\`x\\`/100%%/c\\\\d"',
    );
    expect(autostartEntry({ name: "Sub\nKit", executable: "/a\n/b" })).not.toMatch(
      /Name=Sub\nKit|Exec="\/a\n/,
    );
  });

  test("an AppImage registers the image, not the mounted binary", () => {
    expect(
      autostartExecutable({ APPIMAGE: "/home/me/SubKit.AppImage" }, "/tmp/.mount_x/subkit"),
    ).toBe("/home/me/SubKit.AppImage");
    expect(autostartExecutable({}, "/opt/SubKit/subkit-desktop")).toBe(
      "/opt/SubKit/subkit-desktop",
    );
    expect(autostartExecutable({ APPIMAGE: " " }, "/opt/SubKit/subkit-desktop")).toBe(
      "/opt/SubKit/subkit-desktop",
    );
  });

  test("the entry lives in the XDG autostart folder", () => {
    expect(autostartDirectory({}, "/home/me")).toBe("/home/me/.config/autostart");
    expect(autostartDirectory({ XDG_CONFIG_HOME: "/home/me/.cfg/" }, "/home/me")).toBe(
      "/home/me/.cfg/autostart",
    );
    expect(autostartDirectory({ XDG_CONFIG_HOME: "relative" }, "/home/me")).toBe(
      "/home/me/.config/autostart",
    );
  });
});
