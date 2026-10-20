/**
 * Browser half of dsh-revivecoin.
 *
 * Loaded by the Harness module loader: the factory id is the bundle's package
 * name, which is also the key this card registers under in
 * `plugins.bundle.config`. That slot is the harness's official seat for a
 * bundle's own configuration, rendered on the bundle's page in the Plugin
 * Manager between the description and the rows.
 *
 * Configuration is read and written through the host-owned shared form service
 * (`configForms`), which is what `ctx.settingsScope` used to be: DSH 0.1.7
 * replaced the per-plugin settings-scope service with this one, and
 * `webUiSettings` survives only as a compatibility binder over it. The form is
 * addressed by the profile entry id the settings service derives from this
 * plugin's exported `Config` schema, so nothing here invents a namespace.
 */
const FIELDS = [
    { key: 'profile', label: 'Profile', hint: '留空则用 $DSH_PROFILE，再退回 desktop', kind: 'text' },
    { key: 'profileDir', label: 'Profile 目录', hint: '留空则由 profile 名推出', kind: 'text' },
    { key: 'maxFileBytes', label: '单文件上限', hint: '超过就只记清单不复制', kind: 'number', min: 1024, suffix: 'B' },
    { key: 'maxTotalBytes', label: '单枚币总量预算', hint: '超过后剩下的文件只记清单', kind: 'number', min: 1024, suffix: 'B' },
    { key: 'maxSessionFiles', label: '会话文件上限', hint: '按修改时间取最近的 N 个', kind: 'number', min: 1, max: 5000 },
    { key: 'maxFiles', label: '单次扫描文件上限', hint: '防止意外扫进超大目录', kind: 'number', min: 1, max: 50000 },
    { key: 'maxDepth', label: '目录递归深度', hint: '额外路径往下最多走几层', kind: 'number', min: 1, max: 12 },
];
const PACKAGE_NAME = '@local/dsh-revivecoin';
const ENTRY_HINT = 'dsh-revivecoin';
function humanBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / 1024 / 1024).toFixed(0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
/** Render one value for the summary line. */
function displayValue(spec, value) {
    if (value === undefined || value === null || value === '')
        return '默认';
    if (spec.kind === 'number') {
        const n = Number(value);
        return spec.suffix === 'B' ? humanBytes(n) : String(n);
    }
    return String(value);
}
const styles = {
    card: {
        border: '1px solid var(--dsw-alias-line-secondary, rgba(127,127,127,0.22))',
        borderRadius: '10px',
        padding: '14px 16px',
        margin: '0 0 10px',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
    },
    head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '10px',
    },
    title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
    subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '10px 14px',
        marginBottom: '12px',
    },
    field: { display: 'flex', flexDirection: 'column', gap: '4px' },
    label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' },
    hint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))' },
    input: {
        fontSize: '13px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-line-secondary, rgba(127,127,127,0.3))',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        width: '100%',
        boxSizing: 'border-box',
    },
    foot: { display: 'flex', alignItems: 'center', gap: '10px' },
    button: {
        fontSize: '13px',
        padding: '5px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-line-secondary, rgba(127,127,127,0.3))',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
    },
    message: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' },
};
/** Resolve the profile entry id this plugin's Config schema was projected to. */
function findEntryId(configForms) {
    try {
        const snapshot = configForms.describe().getSnapshot();
        const namespaces = snapshot?.view?.namespaces;
        if (!Array.isArray(namespaces))
            return null;
        const match = namespaces.find((entry) => String(entry?.ns ?? '').includes(ENTRY_HINT));
        return match ? String(match.ns) : null;
    }
    catch {
        return null;
    }
}
/**
 * Build the card component against the host's React instance.
 *
 * No JSX: the bundle is compiled without a JSX transform so that a host
 * without `@types/react` still type-checks, and `h` is the element factory the
 * module table hands over.
 */
function createSettingsCard(React, h) {
    return function SettingsCard(props) {
        const { configForms } = props;
        const [status, setStatus] = React.useState('loading');
        const [value, setValue] = React.useState({});
        const [draft, setDraft] = React.useState({});
        const [saving, setSaving] = React.useState(false);
        const [message, setMessage] = React.useState('');
        const formRef = React.useRef(null);
        const revisionRef = React.useRef(undefined);
        const syncFrom = React.useCallback((form) => {
            if (!form) {
                setStatus('unavailable');
                return;
            }
            let snapshot;
            try {
                snapshot = form.getSnapshot();
            }
            catch {
                setStatus('unavailable');
                return;
            }
            if (!snapshot || (snapshot.status !== undefined && snapshot.status !== 'ready')) {
                setStatus('unavailable');
                return;
            }
            const current = (snapshot.value ?? {});
            revisionRef.current = snapshot.revision;
            setValue(current);
            setDraft({ ...current });
            setStatus('ready');
        }, []);
        React.useEffect(() => {
            let form = null;
            let unsubscribeForm;
            let unsubscribeDescribe;
            const bind = () => {
                if (form)
                    return;
                const entryId = findEntryId(configForms);
                if (!entryId)
                    return;
                try {
                    form = configForms.get(entryId);
                }
                catch {
                    return;
                }
                formRef.current = form;
                unsubscribeForm = form.subscribe(() => syncFrom(form));
                syncFrom(form);
            };
            bind();
            try {
                unsubscribeDescribe = configForms.describe().subscribe(bind);
            }
            catch {
                /* describe may not be observable on every host */
            }
            return () => {
                unsubscribeForm?.();
                unsubscribeDescribe?.();
                formRef.current = null;
            };
        }, [configForms, syncFrom]);
        const save = async () => {
            const form = formRef.current;
            if (!form) {
                setMessage('设置入口暂不可用');
                return;
            }
            const ops = [];
            for (const spec of FIELDS) {
                const next = draft[spec.key];
                const previous = value[spec.key];
                if (next === previous)
                    continue;
                const parsed = spec.kind === 'number' ? Math.trunc(Number(next)) : String(next ?? '');
                if (spec.kind === 'number' && !Number.isFinite(parsed)) {
                    setMessage(`「${spec.label}」不是有效数字`);
                    return;
                }
                ops.push({ op: 'set', path: [spec.key], value: parsed });
            }
            if (ops.length === 0) {
                setMessage('没有改动');
                return;
            }
            setSaving(true);
            setMessage('');
            try {
                const accepted = await form.mutate(ops, revisionRef.current);
                setMessage(accepted ? '已保存（下一次调用工具即生效）' : 'Host 拒绝了这次修改');
            }
            catch (error) {
                setMessage(`保存失败：${error?.message ?? error}`);
            }
            finally {
                setSaving(false);
            }
        };
        if (props.view === 'summary') {
            if (status !== 'ready') {
                return h('div', { style: styles.card }, h('div', { style: styles.subtitle }, status === 'loading' ? '复活币设置加载中…' : '复活币设置暂不可用'));
            }
            const parts = FIELDS.slice(2, 5).map((spec) => `${spec.label} ${displayValue(spec, value[spec.key])}`);
            return h('div', { style: styles.card }, h('div', { style: styles.head }, h('div', { style: styles.title }, '复活币设置'), h('div', { style: styles.subtitle }, '可调参数')), h('div', { style: styles.subtitle }, parts.join(' · ')));
        }
        if (status === 'loading') {
            return h('div', { style: styles.card }, h('div', { style: styles.subtitle }, '复活币设置加载中…'));
        }
        if (status !== 'ready') {
            return h('div', { style: styles.card }, h('div', { style: styles.title }, '复活币设置'), h('div', { style: styles.subtitle }, '这台机器上的设置表单还不可用：Host 半的 Config schema 尚未被投影，或设置服务未就绪。'
                + '仍然可以直接编辑 $DSH_HOME/dsh-revivecoin/config.json。'));
        }
        return h('div', { style: styles.card }, h('div', { style: styles.head }, h('div', { style: styles.title }, '复活币设置'), h('div', { style: styles.subtitle }, '保存后下一次调用工具生效；扫描路径在 config.json 里维护')), h('div', { style: styles.grid }, ...FIELDS.map((spec) => h('label', { key: spec.key, style: styles.field }, h('span', { style: styles.label }, spec.label), h('input', {
            style: styles.input,
            type: spec.kind === 'number' ? 'number' : 'text',
            min: spec.min,
            max: spec.max,
            value: draft[spec.key] === undefined || draft[spec.key] === null ? '' : String(draft[spec.key]),
            onChange: (event) => {
                const raw = event.target.value;
                setDraft((previous) => ({ ...previous, [spec.key]: raw === '' ? '' : raw }));
            },
            disabled: saving,
        }), h('span', { style: styles.hint }, spec.hint)))), h('div', { style: styles.foot }, h('button', { type: 'button', style: styles.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'), h('span', { style: styles.message }, message)));
    };
}
const loader = globalThis.__ModuleLoader__;
loader.load({
    id: PACKAGE_NAME,
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const SettingsCard = createSettingsCard(React, h);
        return {
            inject: ['slots'],
            apply(ctx) {
                const configForms = ctx.get ? ctx.get('configForms') : undefined;
                if (!configForms || typeof configForms.get !== 'function' || typeof configForms.describe !== 'function') {
                    // The card is meaningless without the shared form service; say so once
                    // and leave the rest of the page alone.
                    console.error('[dsh-revivecoin] configForms service unavailable; settings card not registered');
                    return;
                }
                ctx.effect(() => {
                    const dispose = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, (ownerProps) => SettingsCard({ ...ownerProps, configForms })));
                    return dispose;
                }, 'dsh-revivecoin: plugin config card');
            },
        };
    },
});
