(ns app.main.ui.workspace.ai-panel
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.ai :as ai]
   [app.main.data.workspace.mcp :as mcp]
   [app.main.data.workspace.selection :as dws]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [clojure.string :as str]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(mf/defc ai-panel*
  [{:keys [file-id page-id selected]}]
  (let [state*      (mf/use-state ai/initial-state)
        state       @state*
        models*     (mf/use-state [])
        model*      (mf/use-state "")
        model       @model*
        controller* (mf/use-var nil)
        mcp-state   (mf/deref refs/mcp)
        file        (mf/deref refs/file)
        page        (mf/deref refs/workspace-page)
        session-id  (:session-id mcp-state)
        connection  (ai/get-connection-state (contains? cf/flags :mcp) mcp-state)
        connected   (= :ready (:status connection))
        stop        (mf/use-fn
                     (fn []
                       (when-let [controller @controller*]
                         (.abort controller)
                         (reset! controller* nil))
                       (swap! state* (fn [state]
                                       (cond-> (assoc state :busy false :executing false :answer "" :plan nil)
                                         (:executing state)
                                         (assoc :error "已停止等待结果；操作可能已经执行，请检查画布。服务不会自动重试。"))))))
        decide      (mf/use-fn
                     (mf/deps state)
                     (fn [action]
                       (when (and (:plan state) (not (:busy state)))
                         (let [controller (js/AbortController.)]
                           (reset! controller* controller)
                           (swap! state* assoc :busy true :error nil :executing (= action "confirm"))
                           (-> (ai/decide-plan action (:plan-scope state) (get-in state [:plan :id]) controller)
                               (p/then (fn [result]
                                         (when (identical? controller @controller*)
                                           (if (= action "confirm")
                                             (swap! state* ai/apply-event {:type "execution" :result result})
                                             (swap! state* (fn [state]
                                                             (-> state
                                                                 (assoc :plan nil :busy false :executing false)
                                                                 (update :messages conj {:role "assistant" :content "已取消计划，未修改画布。"}))))))))
                               (p/catch (fn [error]
                                          (when (identical? controller @controller*)
                                            (swap! state* assoc :busy false :executing false :plan nil :error (.-message error)))))
                               (p/finally (fn []
                                            (when (identical? controller @controller*)
                                              (reset! controller* nil)))))))))
        send        (mf/use-fn
                     (mf/deps file-id page-id selected session-id connected state model)
                     (fn [event]
                       (dom/prevent-default event)
                       (when (and connected (not (:busy state)) (nil? (:plan state))
                                  (not (empty? model))
                                  (not (str/blank? (:draft state))))
                         (let [controller (js/AbortController.)
                               messages   (conj (vec (take-last 10 (:messages state)))
                                                {:role "user" :content (:draft state)})
                               request    {:fileId (str file-id) :pageId (str page-id)
                                           :sessionId session-id :model model
                                           :selectedIds (mapv str (take 40 selected))
                                           :selectionCount (count selected)
                                           :messages (mapv #(select-keys % [:role :content]) messages)}]
                           (reset! controller* controller)
                           (swap! state* assoc :busy true :error nil :draft "" :answer ""
                                  :messages messages :tools {} :context nil :plan nil :execution nil
                                  :plan-scope (select-keys request [:fileId :pageId :sessionId :selectedIds :selectionCount]))
                           (-> (ai/stream-chat request controller
                                               (fn [event]
                                                 (when (identical? controller @controller*)
                                                   (swap! state* ai/apply-event event))))
                               (p/catch (fn [error]
                                          (when (identical? controller @controller*)
                                            (swap! state* ai/apply-event
                                                   {:type "error" :message (.-message error)}))))
                               (p/finally (fn []
                                            (when (identical? controller @controller*)
                                              (reset! controller* nil)))))))))]
    (mf/with-effect [file-id page-id session-id]
      (stop)
      (reset! state* ai/initial-state)
      #(stop))

    (mf/with-effect [selected]
      (when (or (:busy @state*) (:plan @state*))
        (stop)
        (swap! state* assoc :error "选区已改变，原计划已失效。若操作正在执行，请检查画布结果。")))

    (mf/with-effect []
      (let [controller (js/AbortController.)]
        (-> (p/let [response (js/fetch "/api/agent/config" #js {:credentials "same-origin" :signal (.-signal controller)})
                    _        (when-not (.-ok response) (throw (js/Error. "config")))
                    ^js config (.json response)]
              (let [models (vec (.-models config))]
                (reset! models* models)
                (reset! model* (or (first models) ""))))
            (p/catch (fn [_]
                       (when-not (.-aborted (.-signal controller))
                         (swap! state* assoc :error "AI 服务不可用，请检查服务端配置与登录状态。")))))
        #(.abort controller)))

    [:section {:class (stl/css :panel) :aria-label "AI 设计助手" :on-key-down dom/stop-propagation}
     [:header {:class (stl/css :header)}
      [:h2 {:class (stl/css :title)} "AI 设计助手"]
      [:> icon-button* {:variant "ghost" :icon i/close :aria-label "关闭 AI 面板"
                        :on-click #(st/emit! (dw/remove-layout-flag :ai-panel))}]]
     [:div {:class (stl/css :settings)}
      [:div {:class (stl/css :context)}
       [:span {:class (stl/css :context-path) :title (str (:name file) " / " (:name page))}
        (:name file) " / " (:name page)]
       [:span {:class (stl/css :context-meta)} "确认后编辑 · 已选 " (count selected) " 个图层"]]
      [:div {:class (stl/css :model)}
       [:span {:id "ai-model-label" :class (stl/css :label)} "模型"]
       [:> select* {:key (str (seq @models*))
                    :class (stl/css :model-select)
                    :aria-labelledby "ai-model-label"
                    :disabled (or (:busy state) (empty? @models*))
                    :default-selected model
                    :options (if (seq @models*)
                               (mapv #(hash-map :id % :label %) @models*)
                               [{:id "" :label "暂无可用模型"}])
                    :on-change #(reset! model* %)}]]
      (when-not connected
        [:div {:class (stl/css :notice)}
         [:p {:class (stl/css :helper) :role "status"} (:message connection)]
         (case (:action connection)
           :settings
           [:> button* {:variant "secondary" :to "/?screen=settings-integrations"
                        :target "_blank" :rel "noopener noreferrer"} "打开集成设置"]
           :connect
           [:> button* {:variant "secondary" :on-click #(st/emit! (mcp/connect-mcp))} "连接编辑器"]
           nil)])]
     [:div {:class (stl/css :conversation) :role "log" :aria-label "设计对话"}
      (when (empty? (:messages state))
        [:div {:class (stl/css :empty)}
         [:h3 {:class (stl/css :empty-title)} "了解或修改当前设计"]
         [:p {:class (stl/css :helper)} "选中图层，询问设计或描述修改。AI 会先列出操作计划，确认后才会修改画布。"]])
      (for [[index message] (map-indexed vector (:messages state))]
        [:article {:key index :class (stl/css :message)}
         [:span {:class (stl/css :message-author)} (if (= "user" (:role message)) "你" "AI")]
         [:p {:class (stl/css :answer)} (:content message)]
         (for [id (:citations message)]
           (let [shape (some #(when (= id (:id %)) %) (get-in message [:context :shapes]))]
             [:> button* {:key id :variant "ghost" :class (stl/css :citation)
                          :on-click #(when (get @refs/workspace-page-objects (uuid/uuid id))
                                       (st/emit! (dws/select-shapes (d/ordered-set (uuid/uuid id)))
                                                 dw/zoom-to-selected-shape))}
              (:name shape) " · 定位图层"]))])
      (when (:busy state)
        [:p {:class (stl/css :answer)} (:answer state)])
      (when-let [plan (:plan state)]
        [:section {:class (stl/css :plan) :aria-label "待确认操作计划"}
         [:h3 {:class (stl/css :empty-title)} "操作预览"]
         [:p {:class (stl/css :helper)} "计划 5 分钟后过期。确认前请核对目标和属性。"]
         (when (:outsideSelection plan)
           [:p {:class (stl/css :warning) :role "alert"} "包含当前选区以外的修改或新建对象。确认将授权执行下列全部操作。"])
         [:ol {:class (stl/css :plan-list)}
          (for [[index operation] (map-indexed vector (:operations plan))]
            (let [target (some #(when (= (:shapeId operation) (:id %)) %) (:targets plan))]
              [:li {:key index :class (stl/css :plan-step)}
               [:strong (get ai/tool-labels (:tool operation)) "：" (or (:name target) (:name operation))]
               (when (:shapeId operation)
                 [:span {:class (stl/css :helper)} "目标 ID：" (:shapeId operation)])
               (when target
                 [:p {:class (stl/css :helper)} "修改前："
                  (if (= "set_fill" (:tool operation))
                    (ai/get-fill-summary (:fills target))
                    (ai/get-operation-summary
                     (case (:tool operation)
                       "set_text" {:text (:text target)}
                       "set_bounds" (select-keys target [:x :y :width :height])
                       "set_corner_radius" (select-keys target [:cornerRadii])
                       {})))])
               [:p {:class (stl/css :helper)} "修改后：" (ai/get-operation-summary operation)]]))]
         [:p {:class (stl/css :helper)} "修改容器尺寸可能影响子图层。失败时停止后续步骤，已完成的修改会保留，可用原生撤销恢复。"]
         [:div {:class (stl/css :actions)}
          [:> button* {:variant "secondary" :disabled (:busy state) :on-click #(decide "cancel")} "取消计划"]
          [:> button* {:variant "primary" :disabled (or (:busy state) (not connected))
                       :on-click #(decide "confirm")} (if (:busy state) "处理中…" "确认执行")]]])
      (when-let [result (:execution state)]
        [:section {:class (stl/css :plan) :aria-label "操作执行结果"}
         [:h3 {:class (stl/css :empty-title)}
          (get {"success" "已执行并验证" "partial" "部分完成，已停止" "failed" "执行失败"} (:status result))]
         (for [[index step] (map-indexed vector (:steps result))]
           [:div {:key index :class (stl/css :plan-step)}
            [:strong (get ai/tool-labels (:tool step)) " · "
             (get {"success" "回读一致" "failed" "失败" "skipped" "已跳过"} (:status step))]
            (when (:shapeId step)
              [:> button* {:variant "ghost"
                           :on-click #(when (get @refs/workspace-page-objects (uuid/uuid (:shapeId step)))
                                        (st/emit! (dws/select-shapes (d/ordered-set (uuid/uuid (:shapeId step))))
                                                  dw/zoom-to-selected-shape))} "定位对象"])
            (when (:message step) [:p {:class (stl/css :helper)} (:message step)])])])]
     [:div {:class (stl/css :status) :role "status" :aria-live "polite"}
      (for [[name status] (:tools state)]
        [:div {:key name}
         (get {"get_current_design_context" "读取设计上下文"
               "get_current_file_context" "查看当前文件"
               "get_current_page" "查看当前页面"
               "get_selected_shapes" "查看选中图层"
               "get_shape_tree" "查看图层结构"} name (str "规划：" (get ai/tool-labels name name)))
         " · " (if (= status "complete") "已完成" "读取中…")])
      (when (get-in state [:context :truncated]) [:p {:class (stl/css :helper)} "上下文已截断，回答仅基于已读取的图层。"])
      (when (:busy state)
        [:p {:class (stl/css :helper)}
         (if (:executing state) "正在执行并回读核验；停止等待不会撤销已执行的修改。" "正在生成，完成后校验图层引用。")])]
     (when (:error state) [:p {:class (stl/css :error) :role "alert"} (:error state)])
     [:form {:class (stl/css :composer) :on-submit send}
      [:label {:for "ai-question" :class (stl/css :label)} "设计问题"]
      [:textarea {:id "ai-question" :class (stl/css :question) :value (:draft state) :max-length 4000 :rows 3
                  :disabled (:busy state)
                  :placeholder "例如：选中画板的尺寸和背景色是什么？"
                  :on-change #(swap! state* assoc :draft (dom/get-target-val %))}]
      (when-not connected
        [:p {:class (stl/css :helper)} "完成编辑器连接后即可发送。"])
      [:div {:class (stl/css :actions)}
       [:> button* {:variant "ghost" :disabled (or (:busy state) (some? (:plan state)))
                    :on-click #(reset! state* ai/initial-state)} "新对话"]
       (if (:busy state)
         [:> button* {:variant "secondary" :on-click stop} (if (:executing state) "停止等待" "停止")]
         [:> button* {:type "submit" :variant "primary" :disabled (or (not connected) (empty? model) (some? (:plan state))
                                                                      (str/blank? (:draft state)))} "发送"])]]]))
