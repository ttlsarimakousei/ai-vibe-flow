/*
 * 演示站 F：Vue 3 + vue-router（history 模式，登录后按权限动态注册路由）+ Element Plus。
 * 特意覆盖的形态：组件嵌套三层以上（UsersView > UserTable > StatusTag）、函数式组件（StatusTag）、
 * 用 h 函数按配置渲染的表单（ConfigForm）、Teleport 到 body 的弹窗（OrderDialog）、异步组件 + Suspense（ReportView）。
 * 不需要构建：所有组件用字符串模板或 h 函数，直接跑在 vue.global.js 上。
 */
(function () {
  'use strict';
  var Vue = window.Vue;
  var VueRouter = window.VueRouter;
  var EP = window.ElementPlus;
  var h = Vue.h, ref = Vue.ref, reactive = Vue.reactive, computed = Vue.computed, onMounted = Vue.onMounted;
  var defineComponent = Vue.defineComponent, defineAsyncComponent = Vue.defineAsyncComponent;

  // ---- 接口：SPA 自己处理 401，交给路由守卫跳登录 ----
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; });
    });
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  var state = reactive({ user: '', perms: [], permsLoaded: false });

  // ---- 函数式组件：状态标签（无实例、无模板，纯函数） ----
  function StatusTag(props) {
    return h(EP.ElTag, { type: props.status === '启用' ? 'success' : 'danger', size: 'small', class: 'status-tag' }, function () { return props.status; });
  }
  StatusTag.props = { status: String };

  var UserToolbar = defineComponent({
    name: 'UserToolbar',
    emits: ['search'],
    template: '<div class="toolbar" data-comp="UserToolbar"><el-input v-model="kw" placeholder="按姓名搜索" style="width:200px" clearable @keyup.enter="$emit(\'search\', kw)"></el-input>' +
      '<el-button type="primary" @click="$emit(\'search\', kw)">搜索</el-button></div>',
    setup: function () { return { kw: ref('') }; }
  });

  var UserTable = defineComponent({
    name: 'UserTable',
    components: { StatusTag: StatusTag },
    props: { rows: Array, loading: Boolean },
    template: '<el-table :data="rows" v-loading="loading" data-comp="UserTable" class="user-table" stripe>' +
      '<el-table-column prop="id" label="ID" width="70"></el-table-column>' +
      '<el-table-column prop="name" label="姓名" width="120"></el-table-column>' +
      '<el-table-column prop="dept" label="部门" width="120"></el-table-column>' +
      '<el-table-column prop="role" label="角色" width="120"></el-table-column>' +
      '<el-table-column label="状态" width="100"><template #default="{ row }"><status-tag :status="row.status"></status-tag></template></el-table-column>' +
      '</el-table>'
  });

  var UsersView = defineComponent({
    name: 'UsersView',
    components: { UserToolbar: UserToolbar, UserTable: UserTable },
    template: '<div class="view-users" data-comp="UsersView"><user-toolbar @search="onSearch"></user-toolbar>' +
      '<user-table :rows="rows" :loading="loading"></user-table>' +
      '<el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="10" :current-page="page" @current-change="onPage"></el-pagination></div>',
    setup: function () {
      var rows = ref([]), total = ref(0), page = ref(1), q = ref(''), loading = ref(false);
      function load() {
        loading.value = true;
        return api('/api/f/users?q=' + encodeURIComponent(q.value) + '&page=' + page.value + '&size=10').then(function (j) {
          rows.value = j.list || [];
          total.value = j.total || 0;
          loading.value = false;
        });
      }
      function onSearch(kw) { q.value = kw || ''; page.value = 1; load(); }
      function onPage(p) { page.value = p; load(); }
      onMounted(load);
      return { rows: rows, total: total, page: page, loading: loading, onSearch: onSearch, onPage: onPage };
    }
  });

  // ---- 用 h 函数按配置渲染的表单（没有模板） ----
  var ConfigForm = defineComponent({
    name: 'ConfigForm',
    props: { schema: { type: Array, default: function () { return []; } }, model: { type: Object, required: true } },
    setup: function (props, ctx) {
      var formRef = ref(null);
      ctx.expose({ validate: function () { return formRef.value.validate(); }, reset: function () { formRef.value.resetFields(); } });
      var rules = computed(function () {
        var r = {};
        props.schema.forEach(function (f) { if (f.required) r[f.key] = [{ required: true, message: f.label + '不能为空', trigger: 'blur' }]; });
        return r;
      });
      function field(f) {
        var m = props.model;
        var bind = { modelValue: m[f.key], 'onUpdate:modelValue': function (v) { m[f.key] = v; } };
        if (f.type === 'select') {
          return h(EP.ElSelect, Object.assign({ placeholder: '请选择' + f.label, style: 'width:100%' }, bind), function () {
            return f.options.map(function (o) { return h(EP.ElOption, { key: o, label: o, value: o }); });
          });
        }
        if (f.type === 'number') return h(EP.ElInputNumber, Object.assign({ min: 1, max: 999 }, bind));
        if (f.type === 'switch') return h(EP.ElSwitch, bind);
        if (f.type === 'textarea') return h(EP.ElInput, Object.assign({ type: 'textarea', rows: 2, placeholder: '请输入' + f.label }, bind));
        return h(EP.ElInput, Object.assign({ placeholder: '请输入' + f.label }, bind));
      }
      return function () {
        return h(EP.ElForm, { ref: formRef, model: props.model, rules: rules.value, labelWidth: '90px', 'data-comp': 'ConfigForm' }, function () {
          return props.schema.map(function (f) {
            return h(EP.ElFormItem, { key: f.key, label: f.label, prop: f.key }, function () { return field(f); });
          });
        });
      };
    }
  });

  var ORDER_SCHEMA = [
    { key: 'customer', label: '客户名称', type: 'input', required: true },
    { key: 'product', label: '产品', type: 'select', options: ['机械键盘', '无线鼠标', '27寸显示器', '降噪耳机'], required: true },
    { key: 'qty', label: '数量', type: 'number' },
    { key: 'urgent', label: '加急', type: 'switch' },
    { key: 'remark', label: '备注', type: 'textarea' }
  ];

  // ---- Teleport 到 body 的弹窗，里面是配置表单 ----
  var OrderDialog = defineComponent({
    name: 'OrderDialog',
    components: { ConfigForm: ConfigForm },
    props: { modelValue: Boolean },
    emits: ['update:modelValue', 'created'],
    template: '<el-dialog :model-value="modelValue" title="新建订单" width="520px" append-to-body @update:model-value="$emit(\'update:modelValue\', $event)" @closed="onClosed">' +
      '<config-form ref="form" :schema="schema" :model="model"></config-form>' +
      '<template #footer><el-button @click="$emit(\'update:modelValue\', false)">取消</el-button><el-button type="primary" :loading="saving" @click="submit">保存</el-button></template></el-dialog>',
    setup: function (props, ctx) {
      var form = ref(null), saving = ref(false);
      var model = reactive({ customer: '', product: '', qty: 1, urgent: false, remark: '' });
      function onClosed() { model.customer = ''; model.product = ''; model.qty = 1; model.urgent = false; model.remark = ''; }
      function submit() {
        form.value.validate().then(function () {
          saving.value = true;
          return post('/api/f/orders', model).then(function (j) {
            saving.value = false;
            if (j.ok) {
              EP.ElMessage.success({ message: '订单已创建：' + j.item.no, duration: 5000 });
              ctx.emit('created', j.item);
              ctx.emit('update:modelValue', false);
            } else {
              EP.ElMessage.error(j.msg || '保存失败');
            }
          });
        }).catch(function () { /* 校验失败：错误已显示在表单项下方 */ });
      }
      return { form: form, saving: saving, model: model, schema: ORDER_SCHEMA, submit: submit, onClosed: onClosed };
    }
  });

  var OrdersView = defineComponent({
    name: 'OrdersView',
    components: { OrderDialog: OrderDialog },
    template: '<div class="view-orders" data-comp="OrdersView"><div class="toolbar"><el-button type="primary" @click="showDialog = true">新建订单</el-button><span class="muted" id="orderCount">共 {{ rows.length }} 单</span></div>' +
      '<el-table :data="rows" class="order-table" v-loading="loading">' +
      '<el-table-column prop="no" label="订单号" width="150"></el-table-column><el-table-column prop="customer" label="客户" width="160"></el-table-column>' +
      '<el-table-column prop="product" label="产品" width="140"></el-table-column><el-table-column prop="qty" label="数量" width="80"></el-table-column>' +
      '<el-table-column label="加急" width="80"><template #default="{ row }">{{ row.urgent ? "是" : "否" }}</template></el-table-column>' +
      '<el-table-column prop="status" label="状态"></el-table-column></el-table>' +
      '<order-dialog v-model="showDialog" @created="onCreated"></order-dialog></div>',
    setup: function () {
      var rows = ref([]), loading = ref(false), showDialog = ref(false);
      function load() {
        loading.value = true;
        return post('/api/f/orders/reset').then(function () { return api('/api/f/orders'); }).then(function (j) { rows.value = j.list || []; loading.value = false; });
      }
      function onCreated(item) { rows.value.unshift(item); }
      onMounted(load);
      return { rows: rows, loading: loading, showDialog: showDialog, onCreated: onCreated };
    }
  });

  // ---- 异步组件 + async setup，由 Suspense 接管加载态 ----
  var ReportImpl = defineComponent({
    name: 'ReportView',
    template: '<div class="view-report" data-comp="ReportView"><el-row :gutter="16">' +
      '<el-col :span="8"><el-card><div class="stat"><div class="stat-num" id="reportOrders">{{ data.orders }}</div><div class="stat-label">本月订单</div></div></el-card></el-col>' +
      '<el-col :span="8"><el-card><div class="stat"><div class="stat-num" id="reportReturn">{{ data.returnRate }}</div><div class="stat-label">退货率</div></div></el-card></el-col>' +
      '<el-col :span="8"><el-card><div class="stat"><div class="stat-num" id="reportAmount">{{ data.amount }}</div><div class="stat-label">销售额</div></div></el-card></el-col></el-row>' +
      '<el-descriptions title="统计说明" :column="2" border class="desc">' +
      '<el-descriptions-item label="统计周期">{{ data.period }}</el-descriptions-item><el-descriptions-item label="口径">{{ data.caliber }}</el-descriptions-item>' +
      '<el-descriptions-item label="最畅销">{{ data.top }}</el-descriptions-item><el-descriptions-item label="更新时间">{{ data.updated }}</el-descriptions-item></el-descriptions></div>',
    setup: function () {
      return api('/api/f/report').then(function (j) { return { data: j }; });
    }
  });
  var ReportView = defineAsyncComponent(function () {
    return new Promise(function (resolve) { setTimeout(function () { resolve(ReportImpl); }, 1200); });
  });

  var LoginView = defineComponent({
    name: 'LoginView',
    template: '<div class="login-wrap"><el-card class="login-card" data-comp="LoginView"><h1>内网体检演示站 F</h1><p class="hint">Vue 3 + Element Plus，账号 admin / admin123</p>' +
      '<el-form :model="form" label-width="70px" @submit.prevent="login">' +
      '<el-form-item label="用户名" prop="username"><el-input v-model="form.username" placeholder="请输入用户名"></el-input></el-form-item>' +
      '<el-form-item label="密码" prop="password"><el-input v-model="form.password" type="password" placeholder="请输入密码" show-password></el-input></el-form-item>' +
      '<el-button type="primary" class="login-btn" native-type="submit" :loading="loading">登录</el-button>' +
      '<div class="err" role="alert">{{ err }}</div></el-form></el-card></div>',
    setup: function () {
      var form = reactive({ username: '', password: '' });
      var err = ref(''), loading = ref(false);
      var router = VueRouter.useRouter();
      function login() {
        err.value = '';
        loading.value = true;
        post('/api/login', form).then(function (j) {
          loading.value = false;
          if (j.ok) {
            state.user = j.user;
            return loadPerms().then(function () { router.push('/users'); });
          }
          err.value = j.msg || '登录失败';
        });
      }
      return { form: form, err: err, loading: loading, login: login };
    }
  });

  var AppLayout = defineComponent({
    name: 'AppLayout',
    template: '<el-container class="layout" data-comp="AppLayout"><el-aside width="200px" class="aside"><div class="logo">体检演示 F</div>' +
      '<el-menu :default-active="$route.path" router class="menu"><el-menu-item v-for="p in perms" :key="p.name" :index="\'/\' + p.path">{{ p.title }}</el-menu-item></el-menu></el-aside>' +
      '<el-container><el-header class="header"><span class="title">{{ $route.meta.title }}</span><span class="who" id="who">当前用户：{{ user }}</span><el-button size="small" @click="logout">退出</el-button></el-header>' +
      '<el-main><router-view v-slot="{ Component }"><Suspense><component :is="Component"></component><template #fallback><div class="loading" id="viewLoading">页面加载中…</div></template></Suspense></router-view></el-main></el-container></el-container>',
    setup: function () {
      var router = VueRouter.useRouter();
      function logout() {
        post('/api/logout').then(function () { state.user = ''; state.permsLoaded = false; router.push('/login'); });
      }
      return { perms: computed(function () { return state.perms; }), user: computed(function () { return state.user; }), logout: logout };
    }
  });

  var NotFound = defineComponent({ name: 'NotFound', template: '<div class="notfound"><h2>404</h2><p>页面不存在或没有权限：{{ $route.fullPath }}</p></div>' });

  // ---- 路由：静态只有登录、布局壳、404；业务路由登录后按权限 addRoute ----
  var VIEWS = { users: UsersView, orders: OrdersView, report: ReportView };
  var router = VueRouter.createRouter({
    history: VueRouter.createWebHistory('/f/'),
    routes: [
      { path: '/login', name: 'login', component: LoginView, meta: { title: '登录' } },
      { path: '/', name: 'layout', component: AppLayout, redirect: '/users', children: [] },
      { path: '/:pathMatch(.*)*', name: 'notfound', component: NotFound }
    ]
  });
  function addDynamicRoutes() {
    state.perms.forEach(function (p) {
      if (!router.hasRoute(p.name)) router.addRoute('layout', { path: p.path, name: p.name, component: VIEWS[p.name] || NotFound, meta: { title: p.title } });
    });
  }
  function loadPerms() {
    return api('/api/f/permissions').then(function (j) {
      state.perms = j.list || [];
      addDynamicRoutes();
      state.permsLoaded = true;
    });
  }
  router.beforeEach(function (to) {
    if (to.name === 'login') return true;
    var ensureUser = state.user ? Promise.resolve(true) : api('/api/me').then(function (j) { if (j.ok) { state.user = j.user; return true; } return false; });
    return ensureUser.then(function (ok) {
      if (!ok) return { name: 'login', query: { redirect: to.fullPath } };
      if (!state.permsLoaded) return loadPerms().then(function () { return { path: to.fullPath, replace: true }; });
      return true;
    });
  });

  var app = Vue.createApp({ template: '<router-view></router-view>' });
  app.use(router);
  app.use(EP, { locale: window.ElementPlusLocaleZhCn });
  app.mount('#app');
})();
