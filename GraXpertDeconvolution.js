/*
 * GraXpertDeconvolution.js
 * ========================
 *
 * PixInsight 脚本：调用 GraXpert 3.x 的 AI 反卷积（Deconvolution）功能。
 *
 * 功能：
 *   - 将当前 PixInsight 活动图像保存为临时 XISF 文件
 *   - 调用 GraXpert 命令行接口执行反卷积（Object-only 或 Stars-only）
 *   - 将处理结果加载回 PixInsight
 *
 * 界面：
 *   - 标准 Process 界面，右下角提供 "Apply"（应用）按钮，左下角提供
 *     "New Instance"（新实例）按钮，可将脚本拖拽到图像上执行
 *   - 参数自动保存，下次打开时恢复
 *
 * 依赖：
 *   - GraXpert 3.x（>= 3.0，带反卷积功能）。可从 https://github.com/Steffenhir/GraXpert/releases 下载
 *   - PixInsight 1.8.8+（支持 PJSR）
 *
 * 使用：
 *   在 PixInsight 中打开一张线性图像，然后运行本脚本。
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
#include <pjsr/FrameStyle.jsh>

// 全局设置键，用于记住 GraXpert 可执行文件路径
#define GRAXPERT_PATH_KEY "GraXpertDeconvolution/GraXpertPath"

// 参数键（用于 Parameters 持久化，支持 process icon）
// 注意：Parameters 键名不能包含 "/" 等特殊字符，只能使用字母、数字、下划线
#define P_MODE      "gxd_mode"
#define P_STRENGTH  "gxd_strength"
#define P_PSFSIZE   "gxd_psfsize"
#define P_BATCHSIZE "gxd_batchsize"
#define P_GPU       "gxd_gpu"

/**
 * 从 Parameters 恢复参数（用于 process icon 拖拽执行）。
 */
function loadParameters() {
    var params = {
        mode: "Object-only",
        strength: 0.5,
        psfSize: 4.0,
        batchSize: 4,
        gpu: true
    };

    if (Parameters.has(P_MODE))
        params.mode = Parameters.getString(P_MODE);
    if (Parameters.has(P_STRENGTH))
        params.strength = Parameters.getReal(P_STRENGTH);
    if (Parameters.has(P_PSFSIZE))
        params.psfSize = Parameters.getReal(P_PSFSIZE);
    if (Parameters.has(P_BATCHSIZE))
        params.batchSize = parseInt(Parameters.get(P_BATCHSIZE));
    if (Parameters.has(P_GPU))
        params.gpu = Parameters.getBoolean(P_GPU);

    return params;
}

/**
 * 将参数保存到 Parameters（用于创建 process icon）。
 */
function saveParameters(params) {
    Parameters.set(P_MODE, params.mode);
    Parameters.set(P_STRENGTH, params.strength);
    Parameters.set(P_PSFSIZE, params.psfSize);
    Parameters.set(P_BATCHSIZE, params.batchSize);
    Parameters.set(P_GPU, params.gpu);
}

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
 * 将指定视图（或当前活动图像）保存为临时 XISF 文件，返回文件路径。
 * 使用 ImageWindow.saveAs 保存（与 GraXpert Suite 相同的调用方式，不弹出选项对话框）。
 * @param targetView 可选，指定要保存的视图；为 null 时使用活动窗口。
 */
function saveActiveImageAsXISF(targetView) {
    var window = null;
    if (targetView != null && targetView.window != null)
        window = targetView.window;
    else
        window = ImageWindow.activeWindow;

    if (window == null) {
        throw Error("没有活动图像窗口。请先在 PixInsight 中打开一张图像。");
    }

    var tempDir = File.systemTempDirectory;
    var xisfPath = tempDir + "/graxpert_input_" + String(Date.now()) + ".xisf";

    // 保存为 XISF（参数顺序参考 GraXpert Suite：path, false, false, true, false）
    if (!window.saveAs(xisfPath, false, false, true, false)) {
        throw Error("保存临时 XISF 文件失败。");
    }

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
 * 显示参数对话框，返回用户选择的操作。
 * 返回值：
 *   { action: "apply", params: {...} }       点击 Apply（处理当前活动图像）
 *   { action: "newInstance", params: {...} } 点击 New Instance（创建实例图标）
 *   null                                      取消 / 关闭对话框
 *
 * 界面右下角提供 "Apply"（应用）按钮，左下角提供 "New Instance"（新实例）按钮。
 */
function collectParameters() {
    var dialog = new Dialog;

    // 从已保存的 Parameters 恢复初始值（首次运行时为默认值）
    var init = loadParameters();

    // 在标题中显示当前活动图像名称
    var currentId = "";
    if (ImageWindow.activeWindow != null)
        currentId = ImageWindow.activeWindow.mainView.id;
    dialog.title = "GraXpert 反卷积参数" + (currentId.length > 0 ? " — " + currentId : "");

    dialog.help = "设置 GraXpert 反卷积的参数。\n" +
                  "Object-only: 仅反卷积深空天体；Stars-only: 仅反卷积恒星。\n" +
                  "点击\"Apply\"处理当前活动图像（对话框保持打开，可切换图像连续处理）；\n" +
                  "点击左下角\"New Instance\"创建可拖动的处理实例图标。";

    // --- 控件 ---
    var modeLabel = new Label(dialog);
    modeLabel.text = "反卷积模式:";
    modeLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

    var modeCombo = new ComboBox(dialog);
    modeCombo.editEnabled = false;
    modeCombo.addItem("Object-only");
    modeCombo.addItem("Stars-only");
    modeCombo.currentItem = (init.mode === "Stars-only") ? 1 : 0;

    var strengthSpin = new NumericControl(dialog);
    strengthSpin.label.text = "反卷积强度 (0.0 - 1.0):";
    strengthSpin.setRange(0.0, 1.0);
    strengthSpin.setPrecision(3);
    strengthSpin.setValue(init.strength);

    var psfSpin = new NumericControl(dialog);
    psfSpin.label.text = "PSF 尺寸 (像素):";
    psfSpin.setRange(0.0, 100.0);
    psfSpin.setPrecision(3);
    psfSpin.setValue(init.psfSize);

    var batchSpin = new NumericControl(dialog);
    batchSpin.label.text = "并行块数 (1-32):";
    batchSpin.setRange(1, 32);
    batchSpin.setPrecision(0);
    batchSpin.setValue(init.batchSize);

    var gpuCheck = new CheckBox(dialog);
    gpuCheck.text = "启用 GPU 加速";
    gpuCheck.checked = init.gpu;

    // 收集当前控件值的辅助函数
    function currentParams() {
        return {
            mode: modeCombo.currentItem === 0 ? "Object-only" : "Stars-only",
            strength: strengthSpin.value,
            psfSize: psfSpin.value,
            batchSize: Math.round(batchSpin.value),
            gpu: gpuCheck.checked
        };
    }

    // 用户选择的操作
    var action = null;

    // --- New Instance 按钮（左下角，蓝色三角图标）---
    // 点击后创建处理实例（process icon）。注意：PixInsight 脚本实例不能在脚本运行时
    // 递归执行，因此创建实例后需要关闭对话框，再将图标拖到图像上执行。
    var newInstanceButton = new ToolButton(dialog);
    newInstanceButton.icon = dialog.scaledResource(":/process-interface/new-instance.png");
    newInstanceButton.setScaledFixedSize(24, 24);
    newInstanceButton.toolTip = "<p>New Instance：创建处理实例（图标）。创建后对话框会关闭，可将图标拖到图像上或工作区。</p>";
    newInstanceButton.onMousePress = function() {
        // 保存参数到 Parameters，供 process icon 使用
        saveParameters(currentParams());
        action = "newInstance";
        // 创建脚本实例（process icon）
        dialog.newInstance();
    };
    newInstanceButton.onMouseRelease = function() {
        // 必须关闭对话框，否则脚本实例无法在图像上执行
        // （PixInsight 不支持脚本实例递归执行）
        dialog.ok();
    };

    // --- Apply 按钮（右下角，绿色对勾图标）---
    // 处理当前活动图像，对话框保持打开，可切换图像连续处理
    var applyButton = new PushButton(dialog);
    applyButton.text = "Apply";
    applyButton.icon = dialog.scaledResource(":/icons/ok.png");
    applyButton.toolTip = "<p>对当前活动图像执行 GraXpert 反卷积。对话框保持打开，可切换到其他图像继续处理。</p>";
    applyButton.onClick = function() {
        action = "apply";
        saveParameters(currentParams());   // 保存参数供下次使用
        dialog.ok();
    };

    // --- Cancel 按钮 ---
    var cancelButton = new PushButton(dialog);
    cancelButton.text = "Cancel";
    cancelButton.icon = dialog.scaledResource(":/icons/cancel.png");
    cancelButton.onClick = function() {
        action = null;
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

    // 按钮行：左下角 New Instance，右下角 Apply / Cancel
    var buttonRow = new HorizontalSizer;
    buttonRow.spacing = 8;
    buttonRow.add(newInstanceButton);   // 左下角
    buttonRow.addStretch();
    buttonRow.add(applyButton);         // 右下角
    buttonRow.add(cancelButton);
    sizer.add(buttonRow);

    dialog.sizer = sizer;
    dialog.buttons = Dialog.None;
    dialog.execute();

    if (action == null)
        return null;

    return { action: action, params: currentParams() };
}

/**
 * 处理图像（单次反卷积流程）。
 * @param graxpertPath GraXpert 可执行文件路径
 * @param params 反卷积参数
 * @param targetView 可选，指定要处理的视图；为 null 时使用活动窗口。
 */
function processActiveImage(graxpertPath, params, targetView) {
    // 0. 记录原始视图名称（用于结果窗口命名）
    var sourceWindow = null;
    if (targetView != null && targetView.window != null)
        sourceWindow = targetView.window;
    else
        sourceWindow = ImageWindow.activeWindow;
    var sourceId = (sourceWindow != null) ? sourceWindow.mainView.id : "image";

    // 1. 保存图像为临时 XISF
    Console.writeln("正在保存图像为临时 XISF ...");
    var inputPath = saveActiveImageAsXISF(targetView);
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

    // 重命名结果窗口：使用原图像名 + "_deconv" 后缀（避免使用临时文件名）
    var newId = sourceId + "_deconv";
    resultWindow.mainView.id = newId;

    resultWindow.show();
    Console.writeln("<br><b>反卷积完成！</b> 结果窗口: " +
                    resultWindow.mainView.id + "<br>");

    // 6. 清理临时输入文件（保留结果）
    File.remove(inputPath);
}

/**
 * 主流程。
 *
 * 两种运行模式：
 *   1. Process icon 拖拽到图像上（Parameters.isViewTarget == true）：
 *      直接使用保存的参数处理目标视图，不显示对话框。
 *   2. 正常打开脚本：循环显示参数对话框，
 *      - 点击 "Apply"：处理当前活动图像，对话框重新显示，可切换图像连续处理
 *      - 点击 "New Instance"：创建实例图标并关闭对话框
 *      - 点击 "Cancel"：结束脚本
 */
function main() {
    // PJSR 中 Console 是全局单例对象，直接使用，无需构造
    Console.show();

    Console.writeln("<br>===== GraXpert 反卷积 =====<br>");

    // 1. 获取 GraXpert 可执行文件路径
    var graxpertPath = getGraXpertPath();
    if (graxpertPath.length === 0) {
        Console.writeln("未选择 GraXpert 可执行文件，操作已取消。");
        return;
    }
    Console.writeln("GraXpert 路径: " + graxpertPath);

    // 2. 判断运行模式
    if (Parameters.isViewTarget) {
        // === 模式 1：process icon 拖拽到图像上，直接处理 ===
        var targetView = Parameters.targetView;
        if (targetView == null || !targetView.id) {
            Console.writeln("<red>没有目标视图。</red>");
            return;
        }

        var params = loadParameters();
        Console.writeln("目标图像: " + targetView.id);
        Console.writeln("模式: " + params.mode);
        Console.writeln("强度: " + params.strength);
        Console.writeln("PSF 尺寸: " + params.psfSize);
        Console.writeln("并行块数: " + params.batchSize);
        Console.writeln("GPU 加速: " + params.gpu);

        try {
            processActiveImage(graxpertPath, params, targetView);
        }
        catch (e) {
            Console.writeln("<red>错误:</red> " + e.message);
            Console.writeln("反卷积失败。请检查 GraXpert 路径和参数。");
        }
        return;
    }

    // === 模式 2：正常打开脚本，循环显示对话框 ===
    while (true) {
        // 检查是否有活动图像
        if (ImageWindow.activeWindow == null) {
            Console.writeln("<red>没有活动图像窗口。</red> 请先打开一张图像。");
            break;
        }

        // 显示参数对话框
        var result = collectParameters();
        if (result == null) {
            Console.writeln("用户取消，脚本结束。");
            break;
        }

        // New Instance：创建实例后结束脚本（图标已创建）
        if (result.action === "newInstance") {
            Console.writeln("已创建处理实例图标。可将图标拖到图像上或工作区。");
            break;
        }

        // Apply：处理当前活动图像，然后继续循环
        var params = result.params;
        var activeId = ImageWindow.activeWindow.mainView.id;
        Console.writeln("<br>----- 处理图像: " + activeId + " -----");
        Console.writeln("模式: " + params.mode);
        Console.writeln("强度: " + params.strength);
        Console.writeln("PSF 尺寸: " + params.psfSize);
        Console.writeln("并行块数: " + params.batchSize);
        Console.writeln("GPU 加速: " + params.gpu);

        try {
            processActiveImage(graxpertPath, params, null);
        }
        catch (e) {
            Console.writeln("<red>错误:</red> " + e.message);
            Console.writeln("反卷积失败。请检查 GraXpert 路径和参数。");
        }

        // 处理完成后继续循环，对话框重新显示，可切换到下一张图像
        Console.writeln("<br>可切换到下一张图像后再次点击\"Apply\"，或点击\"Cancel\"结束脚本。<br>");
    }
}

main();
