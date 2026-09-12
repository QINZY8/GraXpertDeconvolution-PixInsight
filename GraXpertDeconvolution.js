/*
 * GraXpertDeconvolution.js
 * ========================
 *
 * PixInsight 脚本：调用 GraXpert 3.x 的 AI 反卷积（Deconvolution）功能。
 *
 * 功能：
 *   - 将当前 PixInsight 活动图像保存为临时 FITS 文件
 *   - 调用 GraXpert 命令行接口执行反卷积（Object-only 或 Stars-only）
 *   - 将处理结果加载回 PixInsight
 *
 * 依赖：
 *   - GraXpert 3.x（>= 3.0，带反卷积功能）。可从 https://github.com/Steffenhir/GraXpert/releases 下载
 *   - PixInsight 1.8.8+（支持 PJSR）
 *
 * 使用：
 *   在 PixInsight 中打开一张线性图像，然后 运行 本脚本。
 *   首次运行时需指定 GraXpert 可执行文件的完整路径（会保存在全局偏好中）。
 * 
 *   作者：QINZY8
 *   仓库：https://github.com/QINZY8/GraXpertDeconvolution-PixInsight
 */

#feature-id GraXpertDeconvolution
#feature-info 调用 GraXpert AI 反卷积功能

#include <pjsr/DataType.jsh>
#include <pjsr/ProcessError.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/Sizer.jsh>

// 全局设置键，用于记住 GraXpert 可执行文件路径
#define GRAXPERT_PATH_KEY "GraXpertDeconvolution/GraXpertPath"

/**
 * 获取 GraXpert 可执行文件路径（优先从设置读取，否则让用户选择）。
 */
function getGraXpertPath() {
    var path = Settings.read(GRAXPERT_PATH_KEY, DataType_UCString);
    if (!Settings.lastReadOK)
        path = "";

    if (path.length === 0 || !File.exists(path)) {
        var fd = new OpenFileDialog();
        fd.caption = "选择 GraXpert 可执行文件";
        #ifeq __PI_PLATFORM__ MSWINDOWS
            fd.filters = [["Programs", ".exe", ".bat"]];
        #else
            fd.filters = [["Apps", ".app"]];
        #endif
        if (fd.execute()) {
            path = fd.fileName;
            Settings.write(GRAXPERT_PATH_KEY, DataType_UCString, path);
        }
    }
    return path;
}

/**
 * 将当前活动图像保存为临时 XISF 文件，返回文件路径。
 * 使用 Image.saveAsXISF 避免弹出 XISF 选项对话框。
 */
function saveActiveImageAsXISF() {
    var window = ImageWindow.activeWindow;
    if (window == null) {
        throw Error("没有活动图像窗口。请先在 PixInsight 中打开一张图像。");
    }

    var tempDir = File.systemTempDirectory;
    var xisfPath = tempDir + "/graxpert_input_" + String(Date.now()) + ".xisf";

    // 使用底层 Image 方法保存，不弹出选项对话框
    window.mainView.image.saveAsXISF(xisfPath);

    return xisfPath;
}

/**
 * 构建 GraXpert 反卷积命令行字符串。
 */
function buildCommand(graxpertPath, inputPath, outputPath, params) {
    var cmd = "\"" + graxpertPath + "\"";

    // 必须使用 -cli 以进入命令行模式
    cmd += " -cli";

    // 选择反卷积模式
    if (params.mode === "Object-only")
        cmd += " -cmd deconv-obj";
    else
        cmd += " -cmd deconv-stellar";

    // 输入文件
    cmd += " \"" + inputPath + "\"";

    // 输出文件（不带扩展名，GraXpert 会自动添加 .fits/.xisf）
    cmd += " -output \"" + outputPath + "\"";

    // 反卷积参数
    cmd += " -strength " + String(params.strength);
    cmd += " -psfsize " + String(params.psfSize);
    cmd += " -batch_size " + String(params.batchSize);

    // GPU 加速
    cmd += " -gpu " + (params.gpu ? "true" : "false");

    return cmd;
}

/**
 * 收集用户输入的反卷积参数。返回 null 表示用户取消。
 */
function collectParameters() {
    var dialog = new Dialog;

    // 在标题中显示当前活动图像名称
    var currentId = "";
    if (ImageWindow.activeWindow != null)
        currentId = ImageWindow.activeWindow.mainView.id;
    dialog.title = "GraXpert 反卷积参数" + (currentId.length > 0 ? " — " + currentId : "");

    dialog.help = "设置 GraXpert 反卷积的参数。\n" +
                  "Object-only: 仅反卷积深空天体；Stars-only: 仅反卷积恒星。\n" +
                  "点击\"执行\"处理当前图像，处理完成后可切换到下一张图像再次执行。";

    // --- 控件 ---
    var modeLabel = new Label(dialog);
    modeLabel.text = "反卷积模式:";
    modeLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

    var modeCombo = new ComboBox(dialog);
    modeCombo.editEnabled = false;
    modeCombo.addItem("Object-only");
    modeCombo.addItem("Stars-only");
    modeCombo.currentItem = 0;

    var strengthSpin = new NumericControl(dialog);
    strengthSpin.label.text = "反卷积强度 (0.0 - 1.0):";
    strengthSpin.setRange(0.0, 1.0);
    strengthSpin.setPrecision(3);
    strengthSpin.setValue(0.5);

    var psfSpin = new NumericControl(dialog);
    psfSpin.label.text = "PSF 尺寸 (像素):";
    psfSpin.setRange(0.0, 100.0);
    psfSpin.setPrecision(3);
    psfSpin.setValue(4);

    var batchSpin = new NumericControl(dialog);
    batchSpin.label.text = "并行块数 (1-32):";
    batchSpin.setRange(1, 32);
    batchSpin.setPrecision(0);
    batchSpin.setValue(4);

    var gpuCheck = new CheckBox(dialog);
    gpuCheck.text = "启用 GPU 加速";
    gpuCheck.checked = true;

    // 执行 / 取消 按钮
    var okClicked = false;   // 记录是否点击了"执行"
    var execButton = new PushButton(dialog);
    execButton.text = "执行";
    execButton.onClick = function() {
        okClicked = true;
        dialog.ok();
    };

    var cancelButton = new PushButton(dialog);
    cancelButton.text = "取消";
    cancelButton.onClick = function() {
        dialog.cancel();
    };

    // --- 布局 ---
    var sizer = new VerticalSizer;
    sizer.spacing = 8;
    sizer.margin = 8;

    // 模式行
    var modeRow = new HorizontalSizer;
    modeRow.spacing = 8;
    modeRow.add(modeLabel);
    modeRow.add(modeCombo, 1);
    sizer.add(modeRow);

    sizer.add(strengthSpin);
    sizer.add(psfSpin);
    sizer.add(batchSpin);

    var gpuRow = new HorizontalSizer;
    gpuRow.spacing = 8;
    gpuRow.add(gpuCheck, 1);
    sizer.add(gpuRow);

    // 按钮行
    var buttonRow = new HorizontalSizer;
    buttonRow.spacing = 8;
    buttonRow.addStretch();
    buttonRow.add(execButton);
    buttonRow.add(cancelButton);
    sizer.add(buttonRow);

    dialog.sizer = sizer;
    dialog.buttons = Dialog.None;
    dialog.execute();

    if (!okClicked)
        return null;

    return {
        mode: modeCombo.currentItem === 0 ? "Object-only" : "Stars-only",
        strength: strengthSpin.value,
        psfSize: psfSpin.value,
        batchSize: Math.round(batchSpin.value),
        gpu: gpuCheck.checked
    };
}

/**
 * 处理当前活动图像（单次反卷积流程）。
 */
function processActiveImage(graxpertPath, params) {
    // 1. 保存活动图像为临时 XISF
    Console.writeln("正在保存当前图像为临时 XISF ...");
    var inputPath = saveActiveImageAsXISF();
    Console.writeln("输入文件: " + inputPath);

    // 2. 构造输出路径（无扩展名）
    var outputBase = inputPath.replace(/\.xisf$/i, "_result");

    // 3. 构建命令行并执行
    var command = buildCommand(graxpertPath, inputPath, outputBase, params);
    Console.writeln("正在运行 GraXpert 反卷积，请稍候 ...");

    var proc = new ExternalProcess();
    proc.start(command);   // 传入完整命令行字符串

    // 等待进程启动
    if (!proc.waitForStarted()) {
        throw Error("GraXpert 无法启动，请检查路径");
    }

    // 等待进程完成
    while (proc.isRunning) {
        processEvents();
        if (Console.abortRequested) {
            proc.kill();
            throw Error("操作已被用户中止");
        }
        proc.waitForFinished(250);
    }

    // 检查进程错误状态
    if (proc.error == ProcessError_FailedToStart) {
        throw Error("GraXpert 进程无法启动，请检查路径");
    }
    if (proc.error == ProcessError_Crashed) {
        throw Error("GraXpert 进程异常退出");
    }
    if (proc.error == ProcessError_ReadError) {
        throw Error("GraXpert 进程读取错误");
    }
    if (proc.error == ProcessError_UnknownError) {
        throw Error("GraXpert 进程未知错误");
    }

    Console.writeln("GraXpert 处理完成");

    var stderrText = String(proc.stderr);
    if (stderrText.length > 0 && !stderrText.contains("error")) {
        Console.writeln("GraXpert stderr: " + stderrText);
    }

    // 4. 确定输出文件实际路径（.xisf 或 .fits）
    var resultPath = outputBase + ".xisf";
    if (!File.exists(resultPath))
        resultPath = outputBase + ".fits";

    if (!File.exists(resultPath)) {
        // 尝试 GraXpert 默认命名（输入名 + _GraXpert）
        var altBase = inputPath.replace(/\.xisf$/i, "_GraXpert");
        resultPath = altBase + ".xisf";
        if (!File.exists(resultPath))
            resultPath = altBase + ".fits";
    }

    if (!File.exists(resultPath))
        throw Error("找不到 GraXpert 反卷积输出文件。");

    // 5. 加载结果到 PixInsight
    Console.writeln("正在加载结果: " + resultPath);
    var resultWindow = ImageWindow.open(resultPath, "", "", true)[0];
    if (resultWindow == null)
        throw Error("无法打开反卷积结果文件。");

    resultWindow.show();
    Console.writeln("<br><b>反卷积完成！</b> 结果窗口: " +
                    resultWindow.mainView.id + "<br>");

    // 6. 清理临时输入文件（保留结果）
    File.remove(inputPath);
}

/**
 * 主流程。
 * 循环显示参数对话框，允许连续处理多张图片，直到用户点击"取消"。
 */
function main() {
    // PJSR 中 Console 是全局单例对象，直接使用，无需构造
    Console.show();

    Console.writeln("<br>===== GraXpert 反卷积 =====<br>");

    // 1. 选择 GraXpert 可执行文件（仅需一次）
    var graxpertPath = getGraXpertPath();
    if (graxpertPath.length === 0) {
        Console.writeln("未选择 GraXpert 可执行文件，操作已取消。");
        return;
    }
    Console.writeln("GraXpert 路径: " + graxpertPath);

    // 2. 循环处理：每次显示参数对话框，用户可连续处理多张图片
    while (true) {
        // 检查是否有活动图像
        if (ImageWindow.activeWindow == null) {
            Console.writeln("<red>没有活动图像窗口。</red> 请打开一张图像后重新运行脚本。");
            break;
        }

        // 收集反卷积参数
        var params = collectParameters();
        if (params == null) {
            Console.writeln("用户取消，脚本结束。");
            break;
        }

        Console.writeln("<br>----- 处理图像: " + ImageWindow.activeWindow.mainView.id + " -----");
        Console.writeln("模式: " + params.mode);
        Console.writeln("强度: " + params.strength);
        Console.writeln("PSF 尺寸: " + params.psfSize);
        Console.writeln("并行块数: " + params.batchSize);
        Console.writeln("GPU 加速: " + params.gpu);

        try {
            processActiveImage(graxpertPath, params);
        }
        catch (e) {
            Console.writeln("<red>错误:</red> " + e.message);
            Console.writeln("反卷积失败。请检查 GraXpert 路径和参数。");
        }

        // 处理完成后继续循环，用户可以切换到下一张图像再次点击"执行"
        Console.writeln("<br>可以切换到下一张图像后再次点击\"执行\"，或点击\"取消\"结束脚本。<br>");
    }
}

main();
