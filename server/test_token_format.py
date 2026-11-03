"""离线验证：Token URL 全链路 + 返回格式 + 路径穿越防护。

用 mock 顶掉上游游戏服，不产生任何真实网络请求。
"""
import json
import base64
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as srv


class FakeResp:
    status_code = 200
    text = 'junk\x00\x01 Token":"FAKE_ROLE_TOKEN_ABC123","roleId":98765,"other":1'


def check(name, cond, detail=''):
    print(f'  {"✅" if cond else "❌"} {name}{"" if cond else "  <- " + detail}')
    return cond


def main():
    srv.app.config['TESTING'] = True
    client = srv.app.test_client()

    token = srv.load_config()['users']['admin']['token']
    ok = True

    print('【1】Token URL 返回格式（逐个文件）')
    for bin_name in ['中文测试', '测试角色1', 'normal_role']:
        key = srv.encode_url_key(bin_name)
        with patch('requests.request', return_value=FakeResp()):
            resp = client.get(f'/{token}/{bin_name}/{key}')
        ok &= check(f'{bin_name}: HTTP {resp.status_code}', resp.status_code == 200,
                    resp.get_data(as_text=True)[:120])
        if resp.status_code != 200:
            continue
        data = json.loads(resp.get_data(as_text=True))
        decoded = base64.b64decode(data['token']).decode('utf-8')
        inner = json.loads(decoded)
        ok &= check(
            f'{bin_name}: 字段齐全 {list(inner)}',
            all(k in inner for k in ('roleToken', 'sessId', 'connId', 'isRestore')),
            decoded,
        )
        ok &= check(f'{bin_name}: roleToken 提取正确', inner['roleToken'] == 'FAKE_ROLE_TOKEN_ABC123',
                    inner.get('roleToken'))

    print('\n【2】安全防护')
    cases = [
        ('错误 key', f'/{token}/中文测试/WRONGKEY', 403),
        ('错误 token', f'/deadbeef/中文测试/{srv.encode_url_key("中文测试")}', 403),
        ('路径穿越 bin_param', f'/{token}/..%2F..%2Fconfig/Zm9v', 400),
        ('路径穿越 key', f'/{token}/../../etc/passwd/eA==', 404),
        ('不存在的文件', f'/{token}/nofile/{srv.encode_url_key("nofile")}', 404),
    ]
    for label, url, expect in cases:
        r = client.get(url)
        # 404 也算被拦住（路由/文件层拒绝）
        ok &= check(f'{label} -> {r.status_code}（期望 {expect} 或 404）',
                    r.status_code in (expect, 404))

    print('\n【3】文件名安全函数')
    for raw, expect_ok in [
        ('中文测试.bin', True), ('测试角色1.bin', True), ('a b.bin', True),
        ('../../etc/passwd.bin', True),   # 只取 basename -> passwd.bin，落在用户目录内
        ('..\\..\\win.ini.bin', True),
        ('bad/../evil.bin', True),
        ('CON.bin', False), ('evil.exe', False), ('noext', False),
    ]:
        got = srv.safe_bin_filename(raw)
        ok &= check(f'{raw!r} -> {got!r}', (got is not None) == expect_ok)

    print('\n【4】确认结果永远落在用户目录内')
    for raw in ['../../etc/passwd', '..\\..\\config', 'a/b/c', '..', '.']:
        p = srv.safe_path_with_username('admin', raw)
        inside = p is None or os.path.abspath(p).startswith(os.path.abspath(srv.BIN_DIR))
        ok &= check(f'{raw!r} -> {p}', inside)

    print('\n' + ('\u2705 全部通过' if ok else '\u274c 存在失败项'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
