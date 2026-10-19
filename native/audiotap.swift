// wr-audiotap: capture the audio of the app that owns a window, optionally muting it on the speakers.
//
//   wr-audiotap --window <CGWindowID> [--mute]   stream audio
//   wr-audiotap --window <CGWindowID> --list     show which processes would be tapped
//
// On success the first stderr line is JSON ({"sampleRate":…,"channels":2,…}); stdout then carries raw
// interleaved stereo Float32 PCM until stdin closes or the process gets SIGTERM/SIGINT.
// Uses Core Audio process taps (macOS 14.2+).

import AppKit
import CoreAudio
import CoreGraphics
import Darwin
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

// MARK: - Arguments

var windowID: CGWindowID?
var mute = false
var listOnly = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    switch arg {
    case "--window": windowID = args.next().flatMap { CGWindowID($0) }
    case "--mute": mute = true
    case "--list": listOnly = true
    default: fail("unknown argument \(arg)")
    }
}
guard let windowID else { fail("usage: wr-audiotap --window <id> [--mute|--list]") }

// MARK: - Which processes belong to the window's app

guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
      let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t
else { fail("window \(windowID) not found") }

let ownerApp = NSRunningApplication(processIdentifier: ownerPID)
let ownerBundleID = ownerApp?.bundleIdentifier ?? ""
let ownerBundlePath = ownerApp?.bundleURL?.path ?? ""

func processPath(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : ""
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readArray<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _: T.Type) -> [T] {
    var addr = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var items = [T](unsafeUninitializedCapacity: Int(size) / MemoryLayout<T>.stride) { _, count in count = Int(size) / MemoryLayout<T>.stride }
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &items) == noErr else { return [] }
    return items
}

func readValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<T>.size)
    var value = initial
    return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}

struct AudioProcess { let object: AudioObjectID; let pid: pid_t; let bundleID: String; let path: String }

// The app's own process plus helpers that live inside its .app bundle (e.g. Zoom's caphost, Chrome's
// renderers). Matching by path, not bundle-ID prefix, so apps sharing a generic ID aren't swept in.
let matches: [AudioProcess] = readArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, AudioObjectID.self)
    .compactMap { obj in
        guard let pid = readValue(obj, kAudioProcessPropertyPID, pid_t(0)) else { return nil }
        return AudioProcess(object: obj, pid: pid, bundleID: readString(obj, kAudioProcessPropertyBundleID), path: processPath(pid))
    }
    .filter { p in
        p.pid == ownerPID
            || (!ownerBundlePath.isEmpty && p.path.hasPrefix(ownerBundlePath + "/"))
    }

func json(_ object: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
}

let processSummary = matches.map { ["pid": Int($0.pid), "bundleID": $0.bundleID, "path": $0.path] }

if listOnly {
    print(json(["ownerPID": Int(ownerPID), "ownerBundleID": ownerBundleID, "ownerName": ownerApp?.localizedName ?? "", "processes": processSummary]))
    exit(0)
}
guard !matches.isEmpty else { fail("\(ownerApp?.localizedName ?? "That app") hasn't played any audio yet") }

// MARK: - Tap + private aggregate device

let tapDescription = CATapDescription(stereoMixdownOfProcesses: matches.map(\.object))
tapDescription.uuid = UUID()
tapDescription.name = "Window Recorder"
tapDescription.isPrivate = true
// Silence the app on the speakers only while we're reading the tap; everything else keeps playing.
tapDescription.muteBehavior = mute ? .mutedWhenTapped : .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "Creating the audio tap")

guard let format = readValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()) else { fail("Reading the tap format failed") }

let outputDevice = readValue(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(kAudioObjectUnknown)) ?? AudioObjectID(kAudioObjectUnknown)
let outputUID = readString(outputDevice, kAudioDevicePropertyDeviceUID)

let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Window Recorder Tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID), "Creating the aggregate device")

// MARK: - Stream PCM to stdout

let stdout = FileHandle.standardOutput
let ioQueue = DispatchQueue(label: "wr-audiotap.io")
var procID: AudioDeviceIOProcID?
var scratch = [Float]()

check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { _, inputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    guard let first = buffers.first, first.mDataByteSize > 0 else { return }

    if buffers.count == 1 {
        let channels = Int(first.mNumberChannels)
        let samples = UnsafeBufferPointer(start: first.mData!.assumingMemoryBound(to: Float.self), count: Int(first.mDataByteSize) / 4)
        if channels == 2 {
            stdout.write(Data(buffer: samples))
            return
        }
        // Mono or >2 channels interleaved: take the first channel (and second if present) as L/R.
        let frames = samples.count / max(channels, 1)
        scratch.removeAll(keepingCapacity: true)
        for f in 0..<frames {
            let l = samples[f * channels]
            scratch.append(l)
            scratch.append(channels > 1 ? samples[f * channels + 1] : l)
        }
    } else {
        // Non-interleaved: one buffer per channel.
        let l = UnsafeBufferPointer(start: buffers[0].mData!.assumingMemoryBound(to: Float.self), count: Int(buffers[0].mDataByteSize) / 4)
        let r = UnsafeBufferPointer(start: buffers[1].mData!.assumingMemoryBound(to: Float.self), count: Int(buffers[1].mDataByteSize) / 4)
        scratch.removeAll(keepingCapacity: true)
        for f in 0..<min(l.count, r.count) {
            scratch.append(l[f])
            scratch.append(r[f])
        }
    }
    scratch.withUnsafeBufferPointer { stdout.write(Data(buffer: $0)) }
}, "Creating the audio callback")

check(AudioDeviceStart(aggregateID, procID), "Starting audio capture")

FileHandle.standardError.write((json([
    "sampleRate": format.mSampleRate,
    "channels": 2,
    "muted": mute,
    "app": ownerApp?.localizedName ?? "",
    "processes": processSummary,
]) + "\n").data(using: .utf8)!)

// MARK: - Shutdown

func shutdown() -> Never {
    AudioDeviceStop(aggregateID, procID)
    if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let signalSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    return source
}

// The parent closing our stdin (or dying) also ends capture.
DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    DispatchQueue.main.async { shutdown() }
}

dispatchMain()
