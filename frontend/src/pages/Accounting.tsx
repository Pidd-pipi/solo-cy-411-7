import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Col, DatePicker, Descriptions, Form, Input, Modal, Row, Select, Space, Statistic,
  Table, Tabs, Tag, Typography, message
} from 'antd';
import { LockOutlined, RedoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  fetchMyPeriodResult, fetchPeriodSummaries, fetchPeriodVersions
} from '../api/accounting';
import { ActivityCard } from '../components/common/ActivityCard';
import { CategoryBadge } from '../components/common/CategoryBadge';
import { EmptyState } from '../components/common/EmptyState';
import { PeriodStatusTag } from '../components/common/PeriodStatusTag';
import { ACTIVITY_CATEGORY_LABELS, ActivityCategory } from '../constants/activity';
import { PeriodStatus } from '../constants/accounting';
import { Messages } from '../constants/messages';
import { useAuth } from '../hooks/useAuth';
import { usePeriodStore } from '../stores/periodStore';
import {
  Activity, MyPeriodResult, PeriodMemberSummary, PeriodVersion
} from '../types/entities';
import { formatCarbon, formatDate } from '../utils/formatters';

export function Accounting() {
  const { user, token } = useAuth();
  const isAdmin = Boolean(user?.roles?.includes('admin'));
  const periods = usePeriodStore((state) => state.periods);
  const loadPeriods = usePeriodStore((state) => state.load);
  const close = usePeriodStore((state) => state.close);
  const reopen = usePeriodStore((state) => state.reopen);
  const isMonthClosed = usePeriodStore((state) => state.isMonthClosed);

  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void loadPeriods();
  }, [loadPeriods, token]);

  const selected = useMemo(() => periods.find((item) => item.period === month), [periods, month]);
  const closedOptions = useMemo(() => periods.filter((item) => item.status === PeriodStatus.CLOSED).map((item) => item.period), [periods]);

  const onClose = async () => {
    if (!window.confirm(`确认结账 ${month}？结账后该月活动将冻结。`)) return;
    try {
      await close(month);
      message.success(Messages.FRONTEND_PERIOD_CLOSE_OK);
    } catch {
      /* interceptor already surfaced the error */
    }
  };

  const submitReopen = async (values: { reason: string }) => {
    if (!reopenTarget) return;
    await reopen(reopenTarget, values.reason);
    message.success(Messages.FRONTEND_PERIOD_REOPEN_OK);
    setReopenOpen(false);
    setReopenTarget(null);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={2}>碳账期</Typography.Title>
        <Typography.Text type="secondary">按自然月结账，结账后冻结该月活动，仪表盘、目标和排行统一读取快照。</Typography.Text>
      </div>

      <Card>
        <Space wrap>
          <DatePicker
            picker="month"
            allowClear={false}
            value={dayjs(month + '-01')}
            onChange={(value) => value && setMonth(value.format('YYYY-MM'))}
          />
          {selected ? <PeriodStatusTag status={selected.status} version={selected.currentVersion} /> : <Tag>未结账（实时）</Tag>}
          {isAdmin ? (
            <>
              <Button type="primary" icon={<LockOutlined />} disabled={isMonthClosed(month)} onClick={onClose}>发起结账</Button>
              <Button
                icon={<RedoOutlined />}
                disabled={!isMonthClosed(month)}
                onClick={() => { setReopenTarget(month); setReopenOpen(true); }}
              >重开账期</Button>
            </>
          ) : null}
        </Space>
        {selected?.reopenReason ? (
          <Typography.Paragraph type="warning" style={{ marginTop: 12, marginBottom: 0 }}>
            最近重开原因：{selected.reopenReason}（{formatDate(selected.reopenedAt || undefined)}）
          </Typography.Paragraph>
        ) : null}
      </Card>

      {isAdmin ? (
        <AdminPanel period={month} closedOptions={closedOptions} onReopen={(period) => { setReopenTarget(period); setReopenOpen(true); }} />
      ) : (
        <MemberPanel period={month} />
      )}

      <Modal title={`重开账期 ${reopenTarget || ''}`} open={reopenOpen} onCancel={() => setReopenOpen(false)} footer={null} destroyOnClose>
        <Form layout="vertical" onFinish={submitReopen}>
          <Form.Item name="reason" label="重开原因" rules={[{ required: true, message: Messages.FRONTEND_PERIOD_REOPEN_REASON }]}>
            <Input.TextArea rows={3} placeholder="例如：补录一笔上月通勤活动" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block danger>确认重开（恢复实时数据，旧快照保留为历史版本）</Button>
        </Form>
      </Modal>
    </Space>
  );
}

function MemberPanel({ period }: { period: string }) {
  const { token } = useAuth();
  const [version, setVersion] = useState<number | undefined>();
  const [result, setResult] = useState<MyPeriodResult | null>(null);

  useEffect(() => {
    if (!token) return;
    setVersion(undefined);
    void fetchMyPeriodResult(period).then(setResult);
  }, [period, token]);

  const loadVersion = async (value: number) => {
    setVersion(value);
    setResult(await fetchMyPeriodResult(period, value));
  };

  if (!result) return <Card loading />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={<Space>我的账期结果 {result.closed ? <Tag color="success">快照 v{result.version}</Tag> : <Tag>实时</Tag>}</Space>}
        extra={result.closed ? (
          <Select
            size="small" style={{ width: 130 }} placeholder="历史版本" allowClear
            value={version}
            onChange={(value) => (value ? void loadVersion(value) : void fetchMyPeriodResult(period).then((r) => { setVersion(undefined); setResult(r); }))}
            options={Array.from({ length: result.version }, (_, index) => result.version - index).map((value) => ({ value, label: `版本 v${value}` }))}
          />
        ) : null}
      >
        {result.closed ? null : <EmptyState text="该月尚未结账，以下显示当前实时数据；结账后此处只展示冻结快照。" />}
        <Row gutter={16} style={{ marginTop: 12 }}>
          <Col xs={24} md={8}><Statistic title="本月排放" value={formatCarbon(result.totalCarbon)} /></Col>
          <Col xs={24} md={8}><Statistic title="活动条数" value={result.activityCount} /></Col>
          <Col xs={24} md={8}><Statistic title="账期区间" value={`${formatDate(result.start)} ~ ${formatDate(result.end)}`} /></Col>
        </Row>
        <Space wrap style={{ marginTop: 12 }}>
          {Object.values(ActivityCategory).map((category) => (
            <span key={category}><CategoryBadge category={category} /> {formatCarbon(result.byCategory[category] || 0)}</span>
          ))}
        </Space>
      </Card>
      <Card title="个人明细">
        {result.detail.length ? (
          <div className="card-grid">{result.detail.map((activity: Activity) => <ActivityCard key={activity.id} activity={activity} locked={result.closed} />)}</div>
        ) : <EmptyState text="该账期没有活动明细" />}
      </Card>
    </Space>
  );
}

function AdminPanel({ period, closedOptions, onReopen }: { period: string; closedOptions: string[]; onReopen: (period: string) => void }) {
  const { token } = useAuth();
  const [viewPeriod, setViewPeriod] = useState(period);
  const [members, setMembers] = useState<PeriodMemberSummary[]>([]);
  const [versions, setVersions] = useState<PeriodVersion[]>([]);
  const [summaryVersion, setSummaryVersion] = useState<number | undefined>();

  useEffect(() => { setViewPeriod(period); }, [period]);

  useEffect(() => {
    if (!token) return;
    setMembers([]);
    setVersions([]);
    setSummaryVersion(undefined);
    if (!closedOptions.includes(viewPeriod)) return;
    void fetchPeriodSummaries(viewPeriod).then((res) => setMembers(res.members));
    void fetchPeriodVersions(viewPeriod).then((res) => setVersions(res.versions));
  }, [viewPeriod, closedOptions.join(','), token]);

  const loadSummaryVersion = async (value: number) => {
    setSummaryVersion(value);
    const res = await fetchPeriodSummaries(viewPeriod, value);
    setMembers(res.members);
  };

  return (
    <Card>
      <Tabs
        defaultActiveKey="summary"
        items={[
          {
            key: 'summary',
            label: '成员活动汇总',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Select style={{ width: 160 }} value={viewPeriod} onChange={setViewPeriod}
                    options={closedOptions.map((value) => ({ value, label: value }))} placeholder="选择已结账月份" />
                  <Select style={{ width: 130 }} allowClear placeholder="快照版本" value={summaryVersion}
                    onChange={(value) => (value ? void loadSummaryVersion(value) : undefined)}
                    options={versions.map((item) => ({ value: item.version, label: `v${item.version}` }))} />
                </Space>
                <Table rowKey="userId" dataSource={members} pagination={false}
                  columns={[
                    { title: '用户', dataIndex: 'userId' },
                    { title: '地区', dataIndex: 'region' },
                    { title: '活动数', dataIndex: 'activityCount' },
                    { title: '总排放', dataIndex: 'totalCarbon', render: (value: number) => formatCarbon(value) },
                    {
                      title: '分类', dataIndex: 'byCategory',
                      render: (byCategory: Record<string, number>) => Object.values(ActivityCategory)
                        .map((category) => `${ACTIVITY_CATEGORY_LABELS[category]} ${Number(byCategory[category] || 0).toFixed(2)}`).join(' · ')
                    }
                  ]} />
              </>
            )
          },
          {
            key: 'versions',
            label: '历史版本',
            children: (
              <Table rowKey="version" dataSource={versions} pagination={false}
                columns={[
                  { title: '版本', dataIndex: 'version', render: (value: number) => `v${value}` },
                  { title: '结账时间', dataIndex: 'createdAt', render: formatDate },
                  { title: '成员数', dataIndex: 'memberCount' }
                ]} />
            )
          },
          {
            key: 'meta',
            label: '账期说明',
            children: (
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="当前选择月份">{period}</Descriptions.Item>
                <Descriptions.Item label="重开">填写原因后可重开，数据回到实时，原快照保留为历史版本。</Descriptions.Item>
                <Descriptions.Item label="再次结账">生成新版本号，仪表盘 / 目标 / 排行读取当前版本。</Descriptions.Item>
                <Descriptions.Item label="操作"><Button size="small" icon={<RedoOutlined />} disabled={!closedOptions.includes(period)} onClick={() => onReopen(period)}>重开当前月</Button></Descriptions.Item>
              </Descriptions>
            )
          }
        ]}
      />
    </Card>
  );
}
