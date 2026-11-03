import shutil
import requests
import re
import os
import json
import time
import random
import base64
import secrets
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, render_template_string, session, redirect, url_for
from flask_cors import CORS
import werkzeug.utils
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)


def _load_secret_key():
    """会话密钥：优先环境变量，否则持久化到 .secret_key。

    原实现用 os.urandom(24)，进程重启后密钥变化，所有已登录会话立即失效；
    多 worker 部署时每个进程密钥还各不相同，登录态会随机丢失。
    """
    env_key = os.environ.get('SECRET_KEY')
    if env_key:
        return env_key
    key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.secret_key')
    if os.path.exists(key_file):
        with open(key_file, 'r') as f:
            saved = f.read().strip()
        if saved:
            return saved
    generated = secrets.token_hex(32)
    with open(key_file, 'w') as f:
        f.write(generated)
    return generated


app.secret_key = _load_secret_key()
# 上传的 bin 报文通常只有几 KB，限制请求体避免被灌满磁盘/内存
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024
CORS(app)

# 加载配置文件
BASE_DIR = os.environ.get('BASE_DIR') or os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
BIN_DIR = os.path.join(BASE_DIR, 'bin')

if not os.path.exists(BIN_DIR):
    os.makedirs(BIN_DIR)

def _default_config():
    return {
        "users": {
            "admin": {
                "password": generate_password_hash("admin123"),
                "token": secrets.token_hex(16)
            }
        }
    }


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                data = json.load(f)
                # 迁移旧配置格式
                if "username" in data:
                    token = secrets.token_hex(16)
                    new_config = {
                        "users": {
                            data["username"]: {
                                "password": data.get("password", "password"),
                                "token": token
                            }
                        }
                    }
                    save_config(new_config)
                    return new_config
                return data
        except Exception:
            return _default_config()
    else:
        # 如果文件不存在，保存默认配置
        default_config = _default_config()
        save_config(default_config)
        return default_config


def save_config(config_data):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config_data, f, indent=4)


def is_password_hashed(stored):
    return isinstance(stored, str) and stored.startswith(('pbkdf2:', 'scrypt:', 'argon2'))


def verify_password(user_data, password):
    """校验密码。兼容历史配置里的明文密码，校验通过后由调用方升级为哈希。"""
    stored = user_data.get('password', '')
    if not stored:
        return False
    if is_password_hashed(stored):
        return check_password_hash(stored, password)
    return secrets.compare_digest(stored, password)


config = load_config()

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'logged_in' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def get_user_bin_dir(username):
    user_dir = os.path.join(BIN_DIR, username)
    if not os.path.exists(user_dir):
        os.makedirs(user_dir)
    return user_dir

_WINDOWS_RESERVED = {
    'con', 'prn', 'aux', 'nul',
    *(f'com{i}' for i in range(1, 10)),
    *(f'lpt{i}' for i in range(1, 10)),
}


def _stem_is_safe(stem):
    if not stem or stem in ('.', '..') or len(stem) > 120:
        return False
    if stem.lower() in _WINDOWS_RESERVED:
        return False
    # 拦路径穿越与文件系统非法字符（Windows 上 ':' '*' '?' 等会直接失败）
    if any(ch in stem for ch in ('/', '\\', '\x00', ':', '*', '?', '"', '<', '>', '|')):
        return False
    if '..' in stem:
        return False
    if stem[-1] in ('.', ' '):
        return False
    return True


def safe_bin_filename(raw):
    """把用户提交的文件名规范成落盘名，保留中文等原字符。

    不能直接用 werkzeug 的 secure_filename：它只保留 ASCII，
    '中文测试.bin' 会被压成 'bin'（丢掉扩展名，列表里查不到），
    '测试角色1.bin' 会被截成 '1.bin'。而游戏角色名绝大多数是中文。
    """
    name = os.path.basename(str(raw or '').replace('\\', '/')).strip()
    if not name.lower().endswith('.bin'):
        return None
    stem = name[:-4].strip()
    return f'{stem}.bin' if _stem_is_safe(stem) else None


def safe_path_with_username(username, bin_param):
    # 保留原文件名（含中文），只做路径穿越与非法字符校验
    raw = str(bin_param or '')
    name = safe_bin_filename(raw if raw.lower().endswith('.bin') else f'{raw}.bin')
    if not name:
        return None
    user_dir = get_user_bin_dir(username)
    target = os.path.join(user_dir, name)
    # 兜底：确保最终路径没有逃出用户目录
    if os.path.dirname(os.path.abspath(target)) != os.path.abspath(user_dir):
        return None
    return target

def extract_target_chars(text):
    # 保留字母(a-zA-Z)、数字(0-9)及特定符号(+=?/)
    pattern = r'[^a-zA-Z0-9+=?/]'
    return re.sub(pattern, '', text)

ALLOWED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bin')  # 限制文件读取目录
if not os.path.exists(ALLOWED_DIR):
    os.makedirs(ALLOWED_DIR)

def safe_path(bin_param):
    # 过滤危险字符，拼接安全路径
    filename = f"{bin_param}.bin"
    safe_filename = os.path.basename(filename)  # 防止路径遍历
    return os.path.join(ALLOWED_DIR, safe_filename)
    
_TOKEN_VALUE_RE = re.compile(r'[Tt]oken["\']?\s*[:=]\s*["\']?([A-Za-z0-9+/=_\-\.]{8,})')


def extract_token_content(result_str):
    """从上游 authuser 响应里取出 roleToken。

    优先按 key:value 精确匹配：原来的实现先把所有非 [a-zA-Z0-9+=?/] 字符删掉，
    这会把 token 里的 '-' 和 '_' 一起删掉（URL-safe base64 / JWT 常见），
    拿到的 token 是残缺的，表现为“导入成功但连不上”。
    精确匹配失败时再退回原逻辑，兼容旧的原始格式。
    """
    matched = _TOKEN_VALUE_RE.search(result_str)
    if matched:
        return matched.group(1)

    flattened = extract_target_chars(result_str)
    # 查找'token'的位置（注意大小写）
    token_start = flattened.find('Token')
    if token_start == -1:
        return "未找到'Token'关键词"

    # 查找'roleId'的位置（注意大小写）
    roleid_start = flattened.find('roleId')
    if roleid_start == -1:
        return "未找到'roleId'关键词"

    # 计算token结束位置（跳过'token'本身）
    token_end = token_start + len('Token')

    # 提取token到roleId之间的内容
    if token_end >= roleid_start:
        return "token和roleId位置重叠或顺序不正确"
    extracted_content = flattened[token_end:roleid_start]
    return extracted_content

def encode_to_base64(input_string):
    # 将字符串转换为bytes
    input_bytes = input_string.encode('utf-8')
    
    # 进行Base64编码
    encoded_bytes = base64.b64encode(input_bytes)
    
    # 将编码后的bytes转换回字符串
    encoded_string = encoded_bytes.decode('utf-8')
    return encoded_string


def encode_url_key(input_string):
    """URL 路径段专用的 base64。

    标准 base64 会产出 '+' 和 '/'：'/' 会让 /<token>/<bin>/<key> 被切成 4 段直接 404，
    '+' 可能被中间层当成空格。中文角色名很容易命中，所以路径里改用 urlsafe 变体。
    注意：token 字段仍然是标准 base64（前端用 atob 解析，不认 '-' '_'）。
    """
    return base64.urlsafe_b64encode(input_string.encode('utf-8')).decode('utf-8')

def decode_from_base64(encoded_string):
    encoded_bytes = encoded_string.encode('utf-8')
    decoded_bytes = base64.b64decode(encoded_bytes)
    decoded_string = decoded_bytes.decode('utf-8')
    return decoded_string


@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '')
        password = request.form.get('password', '')

        # 重新加载配置
        current_config = load_config()
        users = current_config.get('users', {})

        if username in users and verify_password(users[username], password):
            # 历史配置里的明文密码，校验通过后自动升级为哈希
            if not is_password_hashed(users[username].get('password', '')):
                users[username]['password'] = generate_password_hash(password)
                current_config['users'] = users
                save_config(current_config)
            session['logged_in'] = True
            session['username'] = username
            return redirect(url_for('index'))
        else:
            error = '无效的凭证'
    
    return render_template_string('''
<!DOCTYPE html>
<html>
<head>
    <title>登录</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
        .login-container { background: white; padding: 30px; border-radius: 5px; box-shadow: 0 0 10px rgba(0,0,0,0.1); width: 300px; }
        input { display: block; margin: 10px 0; padding: 10px; width: 100%; border: 1px solid #ddd; border-radius: 3px; box-sizing: border-box; }
        button { width: 100%; padding: 10px; background-color: #007bff; color: white; border: none; border-radius: 3px; cursor: pointer; margin-top: 10px; }
        button.secondary { background-color: #6c757d; }
        button:hover { opacity: 0.9; }
        .error { color: red; margin-bottom: 10px; font-size: 0.9em; text-align: center; }
        h2 { text-align: center; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="login-container">
        <h2>登录</h2>
        {% if error %}
        <div class="error">{{ error }}</div>
        {% endif %}
        <form method="post">
            <input type="text" name="username" placeholder="用户名" required>
            <input type="password" name="password" placeholder="密码" required>
            <button type="submit">登录</button>
        </form>
        <button class="secondary" onclick="window.location.href='/register'">注册新账号</button>
    </div>
</body>
</html>
    ''', error=error)

@app.route('/register', methods=['GET', 'POST'])
def register():
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '')
        password = request.form.get('password', '')
        
        if not username or not password:
            error = '用户名和密码不能为空'
        else:
            current_config = load_config()
            users = current_config.get('users', {})
            
            if username in users:
                error = '用户名已存在'
            else:
                # 创建新用户
                users[username] = {
                    "password": generate_password_hash(password),
                    "token": secrets.token_hex(16)
                }
                current_config['users'] = users
                save_config(current_config)
                
                # 创建用户目录
                get_user_bin_dir(username)
                
                return redirect(url_for('login'))
    
    return render_template_string('''
<!DOCTYPE html>
<html>
<head>
    <title>注册</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
        .login-container { background: white; padding: 30px; border-radius: 5px; box-shadow: 0 0 10px rgba(0,0,0,0.1); width: 300px; }
        input { display: block; margin: 10px 0; padding: 10px; width: 100%; border: 1px solid #ddd; border-radius: 3px; box-sizing: border-box; }
        button { width: 100%; padding: 10px; background-color: #28a745; color: white; border: none; border-radius: 3px; cursor: pointer; margin-top: 10px; }
        button.secondary { background-color: #6c757d; }
        button:hover { opacity: 0.9; }
        .error { color: red; margin-bottom: 10px; font-size: 0.9em; text-align: center; }
        h2 { text-align: center; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="login-container">
        <h2>注册新账号</h2>
        {% if error %}
        <div class="error">{{ error }}</div>
        {% endif %}
        <form method="post">
            <input type="text" name="username" placeholder="用户名" required>
            <input type="password" name="password" placeholder="密码" required>
            <button type="submit">注册</button>
        </form>
        <button class="secondary" onclick="window.location.href='/login'">返回登录</button>
    </div>
</body>
</html>
    ''', error=error)

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    session.pop('username', None)
    return redirect(url_for('login'))

@app.route('/delete_account', methods=['POST'])
@login_required
def delete_account():
    username = session.get('username')
    
    # 防止删除管理员账号
    if username == 'admin':
        return jsonify({"error": "无法删除管理员账号"}), 403
    
    # 删除用户数据
    current_config = load_config()
    if username in current_config['users']:
        del current_config['users'][username]
        save_config(current_config)
    
    # 删除用户目录
    user_dir = get_user_bin_dir(username)
    if os.path.exists(user_dir):
        try:
            shutil.rmtree(user_dir)
        except Exception as e:
            return jsonify({"error": f"删除文件失败: {str(e)}"}), 500
            
    # 登出
    session.pop('logged_in', None)
    session.pop('username', None)
    
    return jsonify({"message": "账号已删除"})

@app.route('/change_password', methods=['POST'])
@login_required
def change_password():
    username = session.get('username')
    data = request.get_json()
    
    if not data or 'new_password' not in data:
        return jsonify({"error": "新密码不能为空"}), 400
        
    new_password = data['new_password']
    
    current_config = load_config()
    if username in current_config['users']:
        current_config['users'][username]['password'] = generate_password_hash(new_password)
        save_config(current_config)
        return jsonify({"message": "密码修改成功"})
    
    return jsonify({"error": "用户不存在"}), 404

@app.route('/')
@login_required
def index():
    return render_template_string('''
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token URL & Bin 文件管理</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { text-align: center; }
        .header-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .upload-section { margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        th { background-color: #f2f2f2; }
        button { cursor: pointer; padding: 5px 10px; background-color: #007bff; color: white; border: none; border-radius: 3px; }
        button.delete { background-color: #dc3545; }
        button:hover { opacity: 0.8; }
        .url-cell { word-break: break-all; font-family: monospace; font-size: 0.9em; }
        .copy-btn { margin-left: 5px; background-color: #28a745; font-size: 0.8em; }
        .logout-btn { background-color: #6c757d; }
        .delete-account-btn { background-color: #dc3545; margin-right: 10px; }
        .change-password-btn { background-color: #ffc107; color: black; margin-right: 10px; }
        
        /* Modal Styles */
        .modal { display: none; position: fixed; z-index: 1; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.4); }
        .modal-content { background-color: #fefefe; margin: 15% auto; padding: 20px; border: 1px solid #888; width: 300px; border-radius: 5px; }
        .close { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
        .close:hover, .close:focus { color: black; text-decoration: none; cursor: pointer; }
        .modal input { width: 100%; padding: 10px; margin: 10px 0; display: inline-block; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        .modal button { width: 100%; background-color: #4CAF50; color: white; padding: 14px 20px; margin: 8px 0; border: none; border-radius: 4px; cursor: pointer; }
        .modal button:hover { background-color: #45a049; }
    </style>
</head>
<body>
    <div class="header-controls">
        <div>
            <span>欢迎, {{ session['username'] }}</span>
        </div>
        <div>
            <button class="change-password-btn" onclick="openPasswordModal()">修改密码</button>
            {% if session['username'] != 'admin' %}
            <button class="delete-account-btn" onclick="deleteAccount()">注销账号</button>
            {% endif %}
            <button class="logout-btn" onclick="window.location.href='/logout'">退出登录</button>
        </div>
    </div>
    <h1>Token URL & Bin 文件管理</h1>
    
    <div class="upload-section">
        <h3>批量上传 bin 文件</h3>
        <input type="file" id="fileInput" accept=".bin" multiple>
        <button onclick="uploadFile()">上传</button>
    </div>

    <table id="fileTable">
        <thead>
            <tr>
                <th>文件名</th>
                <th>Token URL</th>
                <th>操作</th>
            </tr>
        </thead>
        <tbody>
            <!-- 文件列表将在这里生成 -->
        </tbody>
    </table>

    <!-- Password Change Modal -->
    <div id="passwordModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="closePasswordModal()">&times;</span>
            <h3>修改密码</h3>
            <input type="password" id="newPassword" placeholder="输入新密码">
            <button onclick="changePassword()">确认修改</button>
        </div>
    </div>

    <script>
        const API_BASE = '';

        function openPasswordModal() {
            document.getElementById('passwordModal').style.display = "block";
        }

        function closePasswordModal() {
            document.getElementById('passwordModal').style.display = "none";
            document.getElementById('newPassword').value = "";
        }

        window.onclick = function(event) {
            if (event.target == document.getElementById('passwordModal')) {
                closePasswordModal();
            }
        }

        async function changePassword() {
            const newPassword = document.getElementById('newPassword').value;
            if (!newPassword) {
                alert("请输入新密码");
                return;
            }

            try {
                const response = await fetch(`${API_BASE}/change_password`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ new_password: newPassword })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert(result.message);
                    closePasswordModal();
                } else {
                    alert('修改失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                console.error('修改失败:', error);
                alert('修改出错');
            }
        }

        async function deleteAccount() {
            if (!confirm('确定要注销账号吗？此操作将永久删除您的账号及所有上传的文件，且不可恢复！')) return;
            
            try {
                const response = await fetch(`${API_BASE}/delete_account`, {
                    method: 'POST'
                });
                
                if (response.ok) {
                    alert('账号已注销');
                    window.location.href = '/login';
                } else {
                    const result = await response.json();
                    alert('注销失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                console.error('注销失败:', error);
                alert('注销出错');
            }
        }

        async function loadFiles() {
            try {
                const response = await fetch(`${API_BASE}/api/files`);
                if (response.status === 401 || response.url.includes('/login')) {
                    window.location.href = '/login';
                    return;
                }
                const files = await response.json();
                const tbody = document.querySelector('#fileTable tbody');
                tbody.innerHTML = '';
                
                files.forEach(file => {
                    const tr = document.createElement('tr');
                    
                    const fullUrl = `${window.location.origin}${file.url}`;
                    
                    tr.innerHTML = `
                        <td>${file.filename}</td>
                        <td class="url-cell">
                            <a href="${file.url}" target="_blank">${file.url}</a>
                            <button class="copy-btn" onclick="copyToClipboard('${fullUrl}')">复制完整链接</button>
                        </td>
                        <td>
                            <button class="delete" onclick="deleteFile('${file.filename}')">删除</button>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });
            } catch (error) {
                console.error('加载文件失败:', error);
                // alert('加载文件列表失败');
            }
        }

        async function uploadFile() {
            const fileInput = document.getElementById('fileInput');
            const files = fileInput.files;
            if (files.length === 0) {
                alert('请选择至少一个文件');
                return;
            }
            
            const formData = new FormData();
            let validCount = 0;
            for (let i = 0; i < files.length; i++) {
                if (files[i].name.endsWith('.bin')) {
                    formData.append('files', files[i]);
                    validCount++;
                }
            }
            
            if (validCount === 0) {
                alert('只能上传 .bin 文件');
                return;
            }

            try {
                const response = await fetch(`${API_BASE}/api/upload`, {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                
                if (response.ok) {
                    alert(`成功上传 ${result.uploaded_count} 个文件`);
                    fileInput.value = '';
                    loadFiles();
                } else {
                    if (response.status === 401) window.location.href = '/login';
                    else alert('上传失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                console.error('上传失败:', error);
                alert('上传出错');
            }
        }

        async function deleteFile(filename) {
            if (!confirm(`确定要删除 ${filename} 吗？`)) return;

            try {
                const response = await fetch(`${API_BASE}/api/files/${filename}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    loadFiles();
                } else {
                    if (response.status === 401) window.location.href = '/login';
                    else {
                        const result = await response.json();
                        alert('删除失败: ' + (result.error || '未知错误'));
                    }
                }
            } catch (error) {
                console.error('删除失败:', error);
                alert('删除出错');
            }
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('链接已复制到剪贴板');
            }).catch(err => {
                console.error('复制失败:', err);
                alert('复制失败，请手动复制');
            });
        }

        // 页面加载时获取文件列表
        loadFiles();
    </script>
</body>
</html>
    ''')

@app.route('/api/files', methods=['GET'])
@login_required
def list_files():
    files = []
    username = session.get('username')
    user_dir = get_user_bin_dir(username)
    current_config = load_config()
    user_entry = current_config.get('users', {}).get(username)
    if not user_entry:
        # 账号已被删除但会话残留，直接重新登录
        session.clear()
        return jsonify({"error": "用户不存在，请重新登录"}), 401
    user_token = user_entry['token']
    
    try:
        for filename in os.listdir(user_dir):
            if filename.endswith('.bin'):
                name_no_ext = os.path.splitext(filename)[0]
                encoded_key = encode_url_key(name_no_ext)
                files.append({
                    "filename": filename,
                    "name": name_no_ext,
                    "url": f"/{user_token}/{name_no_ext}/{encoded_key}"
                })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify(files)

@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'files' not in request.files:
        return jsonify({"error": "未找到文件部分"}), 400
    
    files = request.files.getlist('files')
    if not files or files[0].filename == '':
        return jsonify({"error": "未选择文件"}), 400
        
    username = session.get('username')
    user_dir = get_user_bin_dir(username)
    uploaded_count = 0
    skipped = []

    for file in files:
        if not file or not file.filename:
            continue
        filename = safe_bin_filename(file.filename)
        if not filename:
            skipped.append(file.filename)
            continue
        file.save(os.path.join(user_dir, filename))
        uploaded_count += 1

    if uploaded_count > 0:
        result = {"message": "文件上传成功", "uploaded_count": uploaded_count}
        if skipped:
            result["skipped"] = skipped
        return jsonify(result)

    return jsonify({"error": "没有有效的 bin 文件上传", "skipped": skipped}), 400

@app.route('/api/files/<filename>', methods=['DELETE'])
@login_required
def delete_file(filename):
    if not filename.lower().endswith('.bin'):
        return jsonify({"error": "无效的文件名"}), 400

    username = session.get('username')
    file_path = safe_path_with_username(username, filename)
    if not file_path:
        return jsonify({"error": "无效的文件名"}), 400

    if os.path.exists(file_path):
        try:
            os.remove(file_path)
            return jsonify({"message": "文件删除成功"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        return jsonify({"error": "文件未找到"}), 404

@app.route('/<string:token>/<string:bin_param>/<string:key>')
def home(token, bin_param, key):
    # 验证 token
    current_config = load_config()
    users = current_config.get('users', {})
    
    # 查找 token 对应的用户
    valid_user = None
    for username, user_data in users.items():
        if user_data.get('token') == token:
            valid_user = username
            break
    
    if not valid_user:
        return jsonify({"error": "无效的 Token"}), 403

    if key != encode_url_key(bin_param):
        return jsonify({"error": "无效的链接"}), 403

    url = "https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1"
    try:
        # 使用 safe_path 获取用户目录下的文件
        file_path = safe_path_with_username(valid_user, bin_param)
        if not file_path:
            return jsonify({"error": "非法的文件名"}), 400
        with open(file_path, 'rb') as f:
           payload = f.read()
    except FileNotFoundError:
        return jsonify({"error": "文件未找到"}), 404
    except PermissionError:
        return jsonify({"error": "权限不足"}), 403

    headers = {
   'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 7.1.2; SM-G9810 Build/QP1A.190711.020)',
   'Host': 'xxz-xyzw.hortorgames.com',
   'Content-Type': 'application/octet-stream'
    }

    # 必须带超时：原实现无 timeout，上游不响应时会把 Flask worker 永久占住
    try:
        response = requests.request("POST", url, headers=headers, data=payload, timeout=15)
    except requests.exceptions.Timeout:
        return jsonify({"error": "上游登录接口超时"}), 504
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"上游登录接口请求失败: {e}"}), 502

    roletoken = extract_token_content(response.text)
    if roletoken in ("未找到'Token'关键词", "未找到'roleId'关键词", "token和roleId位置重叠或顺序不正确"):
        # 上游返回内容不符合预期，说明 bin 报文失效或账号状态异常
        return jsonify({"error": roletoken, "upstream_status": response.status_code}), 502

    # 与前端 src/utils/token.ts 的 transformToken() 保持同构：
    # 官方客户端在 roleToken 之外还会带上 sessId / connId / isRestore，
    # 前端建连时会把整段 JSON 作为 ?p= 参数发出去，缺字段会导致握手失败。
    now_ms = int(time.time() * 1000)
    json_data = {
        "roleToken": roletoken,
        "sessId": now_ms * 100 + random.randint(0, 99),
        "connId": now_ms + random.randint(0, 9),
        "isRestore": 0,
    }
    json_result = json.dumps(json_data, separators=(',', ':'))
    base64str = encode_to_base64(json_result)
    json_data1 = {"token": base64str}
    json_result1 = json.dumps(json_data1, indent=2)
    return json_result1

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)

# 说明：
# 1. 会话密钥已在上方 _load_secret_key() 统一处理（环境变量 SECRET_KEY 优先，
#    否则持久化到 server/.secret_key），不要再在此处覆盖，否则重启即掉登录态。
# 2. 数据目录 BASE_DIR 可通过环境变量指定，用于把 config.json 与 bin/ 放到持久化卷上；
#    免费平台的本地文件系统是临时的，重启后上传的 bin 会丢失。
