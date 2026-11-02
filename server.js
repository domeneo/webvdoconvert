const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3888;

// ==========================================
// CONFIGURATION: Set your actual paths here
// ==========================================
// Automatically detect FFmpeg executable path
function getFfmpegPath() {
    const candidates = [
        'E:\\ffmpeg\\bin\\ffmpeg.exe',
        'D:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\ffmpeg\\bin\\ffmpeg.exe'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffmpeg'; // fallback to system PATH
}

const FFMPEG_PATH = getFfmpegPath();
let currentConfig = {
    convertDir: fs.existsSync('E:\\ffmpeg\\convert') ? 'E:\\ffmpeg\\convert' : 'D:\\ffmpeg\\convert',
    outputDir: fs.existsSync('E:\\ffmpeg\\convert\\output') ? 'E:\\ffmpeg\\convert\\output' : 'D:\\ffmpeg\\convert\\output'
};

// Global variable to keep track of the active ffmpeg process
let currentActiveProcess = null;
let currentTempOutputPath = null;

// Server-side Batch Queue System
let batchQueue = [];
let isQueueRunning = false;
let currentJobIndex = 0;
let totalJobCount = 0;
let queueConfig = null;
let queueLogs = []; // In-memory logs of batch operation
let latestFfmpegStatus = "";

function broadcastQueueStatus() {
    // Helper to send to any connected SSE clients
    const payload = JSON.stringify({
        type: 'queue_update',
        isQueueRunning,
        currentJobIndex,
        totalJobCount,
        currentFile: isQueueRunning && batchQueue.length > 0 ? batchQueue[0] : null,
        latestFfmpegStatus,
        remainingCount: batchQueue.length
    });
    sseClients.forEach(client => {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (e) {}
    });
}

function broadcastQueueLog(logLine) {
    queueLogs.push(logLine);
    if (queueLogs.length > 300) queueLogs.shift(); // keep last 300 lines
    const payload = JSON.stringify({ type: 'log', log: logLine });
    sseClients.forEach(client => {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (e) {}
    });
}

const sseClients = [];

// Clean up any dangling .tmp files left over from crashes / restarts
function cleanupTempFiles() {
    if (currentConfig && currentConfig.outputDir && fs.existsSync(currentConfig.outputDir)) {
        try {
            const files = fs.readdirSync(currentConfig.outputDir);
            files.forEach(file => {
                if (file.endsWith('.tmp')) {
                    const fullPath = path.join(currentConfig.outputDir, file);
                    fs.unlinkSync(fullPath);
                    console.log(`[Startup Cleanup] Deleted incomplete file: ${file}`);
                }
            });
        } catch (e) {
            console.error('[Startup Cleanup] Error cleaning temp files:', e.message);
        }
    }
}
cleanupTempFiles();

app.use(express.json());

// Main Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint to get current folder paths and common suggested paths
app.get('/api/config', (req, res) => {
    const suggested = [
        { convertDir: 'E:\\ffmpeg\\convert', outputDir: 'E:\\ffmpeg\\convert\\output' },
        { convertDir: 'D:\\ffmpeg\\convert', outputDir: 'D:\\ffmpeg\\convert\\output' },
        { convertDir: 'C:\\ffmpeg\\convert', outputDir: 'C:\\ffmpeg\\convert\\output' }
    ].filter(item => fs.existsSync(item.convertDir));

    res.json({
        ffmpegPath: FFMPEG_PATH,
        convertDir: currentConfig.convertDir,
        outputDir: currentConfig.outputDir,
        suggested
    });
});

// Endpoint to update active convert/output paths dynamically
app.post('/api/config', (req, res) => {
    const { convertDir, outputDir } = req.body;
    if (!convertDir) {
        return res.status(400).json({ error: "Source folder path (convertDir) is required." });
    }

    const cleanConvertDir = path.normalize(convertDir.trim());
    if (!fs.existsSync(cleanConvertDir)) {
        return res.status(404).json({ error: `Source folder not found on server: ${cleanConvertDir}` });
    }

    const cleanOutputDir = outputDir && outputDir.trim()
        ? path.normalize(outputDir.trim())
        : path.join(cleanConvertDir, 'output');

    if (!fs.existsSync(cleanOutputDir)) {
        try {
            fs.mkdirSync(cleanOutputDir, { recursive: true });
        } catch (e) {
            return res.status(500).json({ error: `Cannot create output folder: ${e.message}` });
        }
    }

    currentConfig.convertDir = cleanConvertDir;
    currentConfig.outputDir = cleanOutputDir;
    cleanupTempFiles();

    res.json({
        message: "Paths updated successfully",
        convertDir: currentConfig.convertDir,
        outputDir: currentConfig.outputDir
    });
});

// Endpoint to list scan directory files (and check whether already converted)
app.get('/api/files', (req, res) => {
    const targetConvertDir = (req.query.convertDir && req.query.convertDir.trim())
        ? path.normalize(req.query.convertDir.trim())
        : currentConfig.convertDir;
    const targetOutputDir = (req.query.outputDir && req.query.outputDir.trim())
        ? path.normalize(req.query.outputDir.trim())
        : currentConfig.outputDir;

    if (!fs.existsSync(targetConvertDir)) {
        return res.status(404).json({ error: `Directory not found: ${targetConvertDir}` });
    }

    fs.readdir(targetConvertDir, (err, files) => {
        if (err) return res.status(500).json([]);
        const allowedExtensions = ['.mp4', '.mkv', '.mov', '.MOV', '.avi'];
        const filtered = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                try {
                    return allowedExtensions.includes(ext) && fs.statSync(path.join(targetConvertDir, file)).isFile();
                } catch (e) {
                    return false;
                }
            })
            .map(file => {
                const convertedName = path.parse(file).name + '.mp4';
                const convertedExists = fs.existsSync(path.join(targetOutputDir, convertedName));
                return {
                    name: file,
                    hasConverted: convertedExists
                };
            });
        res.json(filtered);
    });
});

// Function to build ffmpeg command for a given file and config
function buildTranscodeCommand(filename, config) {
    const { hardwareMode, qp, bitrate, preset, convertDir, outputDir, startTime, endTime } = config;
    const activeConvertDir = convertDir || currentConfig.convertDir;
    const activeOutputDir = outputDir || currentConfig.outputDir;

    const inputPath = path.join(activeConvertDir, filename);
    const outputName = path.parse(filename).name + '.mp4';
    const outputPath = path.join(activeOutputDir, outputName);
    const tempOutputPath = outputPath + '.tmp';

    // Time trimming flags (-ss before -i for fast seek, -to / -t for duration)
    let trimFlags = '';
    const cleanStart = (startTime !== undefined && startTime !== null && String(startTime).trim() !== '') ? String(startTime).trim() : '';
    const cleanEnd = (endTime !== undefined && endTime !== null && String(endTime).trim() !== '') ? String(endTime).trim() : '';

    if (cleanStart) {
        trimFlags += ` -ss ${cleanStart}`;
    }
    if (cleanEnd) {
        trimFlags += ` -to ${cleanEnd}`;
    }

    // Color tagging flags for standard BT.709
    const colorFlags = '-color_primaries bt709 -color_trc bt709 -colorspace bt709';
    let cleanBitrate = bitrate ? bitrate.trim().replace(/([0-9]+)\s*mb$/i, '$1M') : '';
    let cmd = '';

    if (hardwareMode === 'qsv') {
        const qsvPreset = preset && preset.trim() ? preset.trim() : 'veryslow';
        let rateControl = '';
        if (cleanBitrate) {
            // Aggressive Peak Burst (2.3x maxrate, 2.5x bufsize)
            // Average remains specified bitrate, but peak allows bursts on waves & splashes
            const numeric = parseInt(cleanBitrate) || 20;
            const peakMaxrate = Math.round(numeric * 2.3) + 'M';
            const dynamicBuf = Math.round(numeric * 2.5) + 'M';
            rateControl = `-b:v ${cleanBitrate} -maxrate ${peakMaxrate} -bufsize ${dynamicBuf} -preset ${qsvPreset}`;
        } else {
            // Constant QP mode on Intel QSV (Default QP 23)
            rateControl = `-q ${qp || 23} -preset ${qsvPreset}`;
        }

        // Full Pure Hardware Pipeline + faststart & metadata
        cmd = `"${FFMPEG_PATH}" -y -hwaccel qsv -hwaccel_output_format qsv${trimFlags} -i "${inputPath}" -map_metadata 0 ${colorFlags} -c:v hevc_qsv ${rateControl} -c:a copy -movflags +faststart -f mp4 "${tempOutputPath}"`;
    } else if (hardwareMode === 'vga') {
        let amfQuality = 'balanced';
        if (['slow', 'slower', 'veryslow'].includes(preset)) {
            amfQuality = 'quality';
        } else if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'].includes(preset)) {
            amfQuality = 'speed';
        }
        let rateControl = '';
        if (cleanBitrate) {
            rateControl = `-rc vbr_peak -b:v ${cleanBitrate} -quality ${amfQuality}`;
        } else {
            rateControl = `-rc cqp -qp_p "${qp || 25}" -qp_i "${qp || 25}" -quality ${amfQuality}`;
        }
        cmd = `"${FFMPEG_PATH}" -y -hwaccel auto${trimFlags} -i "${inputPath}" -pix_fmt yuv420p ${colorFlags} -c:v hevc_amf ${rateControl} -c:a copy -f mp4 "${tempOutputPath}"`;
    } else {
        const selectedPreset = preset && preset.trim() ? preset.trim() : 'medium';
        let rateControl = '';
        if (cleanBitrate) {
            const numericBitrate = parseInt(cleanBitrate) || 15; 
            const bufSize = `${numericBitrate * 2}M`;
            rateControl = `-b:v ${cleanBitrate} -maxrate ${cleanBitrate} -bufsize ${bufSize} -x265-params no-sao=1`;
        } else {
            rateControl = `-crf ${qp || 26} -x265-params no-sao=1`;
        }
        cmd = `"${FFMPEG_PATH}" -y${trimFlags} -i "${inputPath}" -pix_fmt yuv420p ${colorFlags} -c:v libx265 -preset ${selectedPreset} ${rateControl} -c:a copy -f mp4 "${tempOutputPath}"`;
    }

    return { cmd, inputPath, outputPath, tempOutputPath };
}

// Process the background server queue one by one
function processNextInQueue() {
    if (batchQueue.length === 0) {
        isQueueRunning = false;
        currentActiveProcess = null;
        currentTempOutputPath = null;
        broadcastQueueLog(`\n[QUEUE FINISHED] 🎉 All ${totalJobCount} jobs completed!`);
        broadcastQueueStatus();
        return;
    }

    isQueueRunning = true;
    currentJobIndex++;
    const filename = batchQueue[0];
    const fileStartTime = Date.now();

    if (!fs.existsSync(currentConfig.outputDir)) {
        fs.mkdirSync(currentConfig.outputDir, { recursive: true });
    }

    const { cmd, outputPath, tempOutputPath } = buildTranscodeCommand(filename, queueConfig);
    currentTempOutputPath = tempOutputPath;

    broadcastQueueLog(`\n[QUEUE ${currentJobIndex}/${totalJobCount}] Starting: ${filename} ...`);
    broadcastQueueLog(`[COMMAND] ${cmd}`);
    broadcastQueueStatus();

    currentActiveProcess = exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        currentActiveProcess = null;

        if (error) {
            if (fs.existsSync(tempOutputPath)) {
                try { fs.unlinkSync(tempOutputPath); } catch (e) {}
            }
            currentTempOutputPath = null;

            const isKilled = error.killed || error.signal === 'SIGTERM';
            if (isKilled) {
                broadcastQueueLog(` -> [STOPPED] Batch cancelled by user.`);
                batchQueue = [];
                isQueueRunning = false;
                broadcastQueueStatus();
                return;
            } else {
                broadcastQueueLog(` -> [FAILED] ${filename} error: ${stderr || error.message}`);
            }
        } else {
            try {
                if (fs.existsSync(tempOutputPath)) {
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    fs.renameSync(tempOutputPath, outputPath);
                }
                const elapsedSec = ((Date.now() - fileStartTime) / 1000).toFixed(2);
                broadcastQueueLog(` -> [SUCCESS] ${filename} completed in ${elapsedSec}s`);
            } catch (renameErr) {
                broadcastQueueLog(` -> [FAILED] Finalize error: ${renameErr.message}`);
            }
        }

        currentTempOutputPath = null;
        batchQueue.shift(); // remove finished file
        processNextInQueue(); // continue to next file automatically
    });

    currentActiveProcess.stderr.on('data', (data) => {
        const text = data.toString();
        latestFfmpegStatus = text;
        const payload = JSON.stringify({ type: 'status_tick', text });
        sseClients.forEach(client => {
            try { client.write(`data: ${payload}\n\n`); } catch (e) {}
        });
    });
}

// SSE stream for real-time progress updates even after reconnecting
app.get('/api/queue-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    // Send current state and recent logs immediately upon connecting
    const initPayload = JSON.stringify({
        type: 'init',
        isQueueRunning,
        currentJobIndex,
        totalJobCount,
        currentFile: isQueueRunning && batchQueue.length > 0 ? batchQueue[0] : null,
        logs: queueLogs,
        latestFfmpegStatus
    });
    res.write(`data: ${initPayload}\n\n`);

    req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

// Endpoint to start batch transcoding (Server-side queue)
app.post('/api/batch-start', (req, res) => {
    const { files, hardwareMode, qp, bitrate, preset, startTime, endTime } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "Files array is required" });
    }

    if (isQueueRunning) {
        return res.status(409).json({ error: "A batch transcoding job is already running on server." });
    }

    batchQueue = [...files];
    totalJobCount = files.length;
    currentJobIndex = 0;
    queueConfig = { hardwareMode, qp, bitrate, preset, startTime, endTime };
    queueLogs = [`[SERVER QUEUE STARTED] Total ${totalJobCount} files queued.`];

    processNextInQueue();
    res.json({ message: "Batch started successfully", total: totalJobCount });
});

// Endpoint to run VMAF comparison between original and converted file
app.post('/api/vmaf', (req, res) => {
    const { filename, seconds } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });

    const originalPath = path.join(currentConfig.convertDir, filename);
    const convertedName = path.parse(filename).name + '.mp4';
    const convertedPath = path.join(currentConfig.outputDir, convertedName);

    if (!fs.existsSync(originalPath)) {
        return res.status(404).json({ error: `Original file not found: ${filename}` });
    }
    if (!fs.existsSync(convertedPath)) {
        return res.status(404).json({ error: `Converted file not found in vault: ${convertedName}` });
    }

    const testDuration = seconds && Number(seconds) > 0 ? Number(seconds) : 15;
    // libvmaf filter compares: [distorted][reference]libvmaf
    // Input #0 = converted (distorted), Input #1 = original (reference)
    // Optimized for speed: n_threads=4 (full Pentium Gold 4 threads) and 15s duration
    const cmd = `"${FFMPEG_PATH}" -y -i "${convertedPath}" -i "${originalPath}" -t ${testDuration} -filter_complex "[0:v]scale=1920:1080:flags=bicubic[dis];[1:v]scale=1920:1080:flags=bicubic[ref];[dis][ref]libvmaf=log_fmt=json:n_threads=4" -f null -`;

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (event) => {
        res.write(`${JSON.stringify(event)}\n`);
    };

    sendEvent({ type: 'command', command: cmd });

    currentActiveProcess = exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        currentActiveProcess = null;
        if (error) {
            const isKilled = error.killed || error.signal === 'SIGTERM';
            sendEvent({
                type: 'result',
                command: cmd,
                error: isKilled ? "killed" : (stderr || error.message)
            });
            return res.end();
        }

        // Try extracting VMAF score from stderr
        const match = stderr.match(/VMAF score:\s*([0-9.]+)/i);
        const score = match ? match[1] : null;

        sendEvent({
            type: 'result',
            command: cmd,
            message: score ? `VMAF Score: ${score} / 100` : "VMAF Test Completed",
            score: score
        });
        res.end();
    });

    currentActiveProcess.stderr.on('data', (data) => {
        sendEvent({ type: 'log', message: data.toString() });
    });
});

// Serve output directory dynamically
app.use('/output', (req, res, next) => {
    express.static(currentConfig.outputDir)(req, res, next);
});

// Endpoint to run SSIM & PSNR test (Strict Structural & Mathematical comparison)
app.post('/api/ssim', (req, res) => {
    const { filename, seconds } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });

    const originalPath = path.join(currentConfig.convertDir, filename);
    const convertedName = path.parse(filename).name + '.mp4';
    const convertedPath = path.join(currentConfig.outputDir, convertedName);

    if (!fs.existsSync(originalPath)) return res.status(404).json({ error: `Original file not found: ${filename}` });
    if (!fs.existsSync(convertedPath)) return res.status(404).json({ error: `Converted file not found in vault: ${convertedName}` });

    const testDuration = seconds && Number(seconds) > 0 ? Number(seconds) : 15;
    // Calculate SSIM and PSNR simultaneously
    const cmd = `"${FFMPEG_PATH}" -y -i "${convertedPath}" -i "${originalPath}" -t ${testDuration} -filter_complex "[0:v]scale=1920:1080:flags=bicubic[dis];[1:v]scale=1920:1080:flags=bicubic[ref];[dis][ref]ssim=stats_file=NUL[s];[0:v]scale=1920:1080:flags=bicubic[dis2];[1:v]scale=1920:1080:flags=bicubic[ref2];[dis2][ref2]psnr=stats_file=NUL[p]" -map "[s]" -f null - -map "[p]" -f null -`;

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (event) => res.write(`${JSON.stringify(event)}\n`);
    sendEvent({ type: 'command', command: cmd });

    currentActiveProcess = exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        currentActiveProcess = null;
        if (error) {
            const isKilled = error.killed || error.signal === 'SIGTERM';
            sendEvent({ type: 'result', command: cmd, error: isKilled ? "killed" : (stderr || error.message) });
            return res.end();
        }

        // Extract SSIM All score (e.g. All:0.9789)
        const ssimMatch = stderr.match(/SSIM.*All:([0-9.]+)/i);
        const ssimScore = ssimMatch ? ssimMatch[1] : null;

        // Extract PSNR average score (e.g. average:42.15)
        const psnrMatch = stderr.match(/PSNR.*average:([0-9.]+)/i);
        const psnrScore = psnrMatch ? psnrMatch[1] : null;

        sendEvent({
            type: 'result',
            command: cmd,
            ssim: ssimScore,
            psnr: psnrScore,
            message: `SSIM: ${ssimScore || 'N/A'} (1.00 คือสมบูรณ์แบบ) | PSNR: ${psnrScore || 'N/A'} dB`
        });
        res.end();
    });

    currentActiveProcess.stderr.on('data', (data) => {
        sendEvent({ type: 'log', message: data.toString() });
    });
});

// Serve convert directory dynamically so browser can directly load original frames
app.use('/convert-source', (req, res, next) => {
    express.static(currentConfig.convertDir)(req, res, next);
});

// Endpoint to extract a burst of 10 synchronized frames (spaced across 2 seconds)
app.post('/api/snapshot-burst', (req, res) => {
    const { filename, startTime } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });

    const originalPath = path.join(currentConfig.convertDir, filename);
    const convertedName = path.parse(filename).name + '.mp4';
    const convertedPath = path.join(currentConfig.outputDir, convertedName);

    if (!fs.existsSync(originalPath)) return res.status(404).json({ error: `Original file not found: ${filename}` });
    if (!fs.existsSync(convertedPath)) return res.status(404).json({ error: `Converted file not found: ${convertedName}` });

    const startSec = Math.max(0, Number(startTime) || 5);
    const burstDir = path.join(currentConfig.outputDir, 'burst_cache');
    if (!fs.existsSync(burstDir)) fs.mkdirSync(burstDir, { recursive: true });

    // Clean old burst cache files
    try {
        const oldFiles = fs.readdirSync(burstDir);
        oldFiles.forEach(f => fs.unlinkSync(path.join(burstDir, f)));
    } catch (e) {}

    // Extract 10 frames across 2 seconds (5 fps = 10 frames total)
    // Fast, lightweight, and perfectly represents motion within 2s
    const cmdOrig = `"${FFMPEG_PATH}" -y -ss ${startSec} -i "${originalPath}" -t 2 -r 5 -q:v 2 "${path.join(burstDir, 'orig_%02d.jpg')}"`;
    const cmdConv = `"${FFMPEG_PATH}" -y -ss ${startSec} -i "${convertedPath}" -t 2 -r 5 -q:v 2 "${path.join(burstDir, 'conv_%02d.jpg')}"`;

    exec(`${cmdOrig} && ${cmdConv}`, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) return res.status(500).json({ error: stderr || error.message });

        // Count generated frames
        const files = fs.readdirSync(burstDir);
        const origFrames = files.filter(f => f.startsWith('orig_')).sort();
        const convFrames = files.filter(f => f.startsWith('conv_')).sort();

        const framePairs = [];
        const count = Math.min(origFrames.length, convFrames.length);
        for (let i = 0; i < count; i++) {
            const timeOffset = (i * 0.2).toFixed(2);
            framePairs.push({
                index: i + 1,
                timeLabel: `+${timeOffset}s`,
                origUrl: `/output/burst_cache/${origFrames[i]}?t=${Date.now()}`,
                convUrl: `/output/burst_cache/${convFrames[i]}?t=${Date.now()}`
            });
        }

        res.json({
            message: "Burst extracted",
            totalFrames: count,
            frames: framePairs
        });
    });
});

// Endpoint to generate separate Full-HD snapshots for interactive synchronized zooming
app.post('/api/snapshot-compare', (req, res) => {
    const { filename, timestamp } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });

    const originalPath = path.join(currentConfig.convertDir, filename);
    const convertedName = path.parse(filename).name + '.mp4';
    const convertedPath = path.join(currentConfig.outputDir, convertedName);

    if (!fs.existsSync(originalPath)) return res.status(404).json({ error: `Original file not found: ${filename}` });
    if (!fs.existsSync(convertedPath)) return res.status(404).json({ error: `Converted file not found in vault: ${convertedName}` });

    const seekTime = timestamp && timestamp.trim() ? timestamp.trim() : '00:00:05';
    const baseName = path.parse(filename).name;
    const origSnapshotName = `${baseName}_orig.jpg`;
    const convSnapshotName = `${baseName}_conv.jpg`;
    const origSnapshotPath = path.join(currentConfig.outputDir, origSnapshotName);
    const convSnapshotPath = path.join(currentConfig.outputDir, convSnapshotName);

    // Extract original and converted at Full 1080p resolution (lossless quality 2)
    const cmdOrig = `"${FFMPEG_PATH}" -y -ss ${seekTime} -i "${originalPath}" -vframes 1 -q:v 2 "${origSnapshotPath}"`;
    const cmdConv = `"${FFMPEG_PATH}" -y -ss ${seekTime} -i "${convertedPath}" -vframes 1 -q:v 2 "${convSnapshotPath}"`;

    exec(`${cmdOrig} && ${cmdConv}`, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: stderr || error.message });
        }
        res.json({
            message: "Comparison snapshots generated",
            origUrl: `/output/${origSnapshotName}?t=${Date.now()}`,
            convUrl: `/output/${convSnapshotName}?t=${Date.now()}`
        });
    });
});

// NEW: Endpoint to forcefully terminate the current FFmpeg process
app.post('/api/stop', (req, res) => {
    // If there is an active transcoding job with a temp file, remove it immediately
    if (currentTempOutputPath && fs.existsSync(currentTempOutputPath)) {
        try {
            fs.unlinkSync(currentTempOutputPath);
            console.log(`[Stop Action] Immediately cleaned up incomplete temp file: ${currentTempOutputPath}`);
        } catch (e) {
            console.error('[Stop Action] Error deleting temp file:', e.message);
        }
    }
    currentTempOutputPath = null;

    if (currentActiveProcess) {
        console.log('[Server] User requested to stop the current job. Killing process tree...');
        const pid = currentActiveProcess.pid;
        currentActiveProcess = null;

        // On Windows, child processes created via exec() or cmd must be killed with taskkill /F /T
        if (process.platform === 'win32' && pid) {
            exec(`taskkill /pid ${pid} /T /F`, (err) => {
                if (err) console.error('[Server] taskkill error:', err.message);
            });
        } else if (pid) {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch (e) {
                // Ignore if already dead
            }
        }
        return res.json({ message: "Process stopped successfully" });
    } else {
        // Fallback: forcefully kill any orphaned ffmpeg.exe processes on Windows
        if (process.platform === 'win32') {
            exec('taskkill /IM ffmpeg.exe /F', () => {});
        }
        return res.json({ message: "No active process tracked, killed any background ffmpeg" });
    }
});

// Endpoint to restart this service through PM2
app.post('/api/restart', (req, res) => {
    const commandShell = process.env.ComSpec || 'cmd.exe';
    const restartProcess = spawn(commandShell, ['/d', '/s', '/c', 'pm2 restart ffmpegServer'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });

    restartProcess.unref();
    res.json({ message: 'Restart command sent to PM2' });
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` 🚀 MULTI-TRANSCODE SERVER RUNNING ON PORT ${PORT}`);
    console.log(` Open on client machine: http://[YOUR-SERVER-IP]:${PORT}`);
    console.log(`====================================================`);
});
