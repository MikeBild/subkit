import { describe, expect, test } from "bun:test";
import { mountPointOf, volumeIdentity, volumeUuidOf } from "./volume-id.ts";

describe("volume identity", () => {
  test("reads the mount point from df -P, also with spaces", () => {
    expect(
      mountPointOf(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1942700360 1702019232 178712992    91%    /System/Volumes/Data\n",
      ),
    ).toBe("/System/Volumes/Data");
    expect(
      mountPointOf(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk5s1 100 50 50 50% /Volumes/My Disk\n",
      ),
    ).toBe("/Volumes/My Disk");
    expect(mountPointOf("")).toBeNull();
    expect(mountPointOf("Filesystem\nnonsense")).toBeNull();
  });

  test("reads the volume UUID from diskutil's plist", () => {
    const plist =
      "<dict>\n\t<key>VolumeUUID</key>\n\t<string>f86988dd-cc7f-4012-9a92-1e5b20d30837</string>\n</dict>";
    expect(volumeUuidOf(plist)).toBe("F86988DD-CC7F-4012-9A92-1E5B20D30837");
    expect(volumeUuidOf("<dict><key>Error</key><true/></dict>")).toBeNull();
  });

  test("prefers the UUID and falls back to st_dev", () => {
    expect(volumeIdentity("ABC", 7)).toBe("uuid:ABC");
    expect(volumeIdentity(null, 16777232)).toBe("16777232");
  });
});
