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
   [app.main.ui.workspace.ai-advanced :refer [ai-advanced*]]
   [app.util.dom :as dom]
   [clojure.string :as str]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(mf/defc ai-panel*
  [{:keys [file-id page-id selected]}]
  (let [state*      (mf/use-state ai/initial-state)
        state       @state*
        models*     (mf/use-state [])
        image-gen*  (mf/use-state false)
        model*      (mf/use-state "")
        model       @model*
        controller* (mf/use-var nil)
        image-read* (mf/use-var nil)
        upload-ref  (mf/use-ref nil)
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
                                       (cond-> (assoc state :busy false :executing false :answer "" :plan nil :plans [])
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
                                                                 (assoc :plan nil :plans [] :busy false :executing false)
                                                                 (update :messages conj {:role "assistant" :content "已取消计划，未修改画布。"}))))))))
                               (p/catch (fn [error]
                                          (when (identical? controller @controller*)
                                            (swap! state* assoc :busy false :executing false :plan nil :plans [] :error (.-message error)))))
                               (p/finally (fn []
                                            (when (identical? controller @controller*)
                                              (reset! controller* nil)))))))))
        cancel-running (mf/use-fn
                        (mf/deps state)
                        (fn []
                          (when (and (:executing state) (not (:cancelling state)))
                            (swap! state* assoc :cancelling true)
                            (-> (ai/decide-plan "cancel" (:plan-scope state) (get-in state [:plan :id]) (js/AbortController.))
                                (p/catch (fn [error]
                                           (swap! state* assoc :cancelling false :error (.-message error))))))))
        send        (mf/use-fn
                     (mf/deps file-id page-id selected session-id connected state model)
                     (fn [event]
                       (dom/prevent-default event)
                       (when (and connected (not (:busy state)) (nil? (:plan state)) (empty? (:plans state))
                                  (not (empty? model))
                                  (not (:reading-image state))
                                  (or (:image state) (not (str/blank? (:draft state)))))
                         (let [controller (js/AbortController.)
                               messages   (conj (vec (take-last 10 (:messages state)))
                                                (cond-> {:role "user" :content (if (str/blank? (:draft state)) "请分析这张参考图。" (:draft state))}
                                                  (:image state) (assoc :image (:image state))))
                               request    {:fileId (str file-id) :pageId (str page-id)
                                           :sessionId session-id :model model
                                           :selectedIds (mapv str (take 40 selected))
                                           :selectionCount (count selected)
                                           :messages (ai/get-chat-messages messages)}]
                           (reset! controller* controller)
                           (swap! state* assoc :busy true :error nil :draft "" :image nil :answer ""
                                  :messages messages :tools {} :context nil :plan nil :plans [] :execution nil
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
                                              (reset! controller* nil)))))))))
        attach      (fn [file]
                      (let [token (js-obj)]
                        (reset! image-read* token)
                        (swap! state* assoc :reading-image true :error nil)
                        (-> (ai/read-chat-image file)
                            (p/then #(when (identical? token @image-read*)
                                       (swap! state* assoc :image %)))
                            (p/catch #(when (identical? token @image-read*)
                                        (swap! state* assoc :error (.-message %))))
                            (p/finally #(when (identical? token @image-read*)
                                          (swap! state* assoc :reading-image false))))))]
    (mf/with-effect [file-id page-id session-id]
      (stop)
      (reset! image-read* nil)
      (reset! state* ai/initial-state)
      #(do (reset! image-read* nil) (stop)))

    (mf/with-effect [selected]
      (when (or (:busy @state*) (:plan @state*) (seq (:plans @state*)))
        (stop)
        (swap! state* assoc :error "选区已改变，原计划已失效。若操作正在执行，请检查画布结果。")))

    (mf/with-effect []
      (let [controller (js/AbortController.)]
        (-> (p/let [response (js/fetch "/api/agent/config" #js {:credentials "same-origin" :signal (.-signal controller)})
                    _        (when-not (.-ok response) (throw (js/Error. "config")))
                    ^js config (.json response)]
              (let [models (vec (.-models config))]
                (reset! models* models)
                (reset! image-gen* (boolean (.-imageGeneration config)))
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
      [:> ai-advanced* {:key (str file-id page-id session-id selected)
                        :scope {:fileId (str file-id) :pageId (str page-id) :sessionId session-id
                                :selectedIds (mapv str (take 40 selected)) :selectionCount (count selected)}
                        :model model :busy (or (:busy state) (some? (:plan state)) (seq (:plans state))) :connected connected
                        :image-generation @image-gen*
                        :controller-ref controller*
                        :on-busy #(swap! state* assoc :busy %)
                        :on-plan (fn [scope plan]
                                   (swap! state* assoc :plan-scope scope :plan plan :plans [] :execution nil))}]
      (when (empty? (:messages state))
        [:div {:class (stl/css :empty)}
         [:h3 {:class (stl/css :empty-title)} "规划页面或修改当前设计"]
         [:p {:class (stl/css :helper)} "描述页面目标、角色和主要区域，也可以选中图层提出局部修改。先核对方案，确认后生成可编辑元素。"]])
      (for [[index message] (map-indexed vector (:messages state))]
        [:article {:key index :class (stl/css :message)}
         [:span {:class (stl/css :message-author)} (if (= "user" (:role message)) "你" "AI")]
         (when-let [image (:image message)]
           [:img {:class (stl/css :image-preview) :src (ai/get-image-data-url image) :alt "发送的参考图"}])
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
      (when (> (count (:plans state)) 1)
        [:section {:class (stl/css :plan) :aria-label "页面方案选择"}
         [:h3 {:class (stl/css :empty-title)} "选择一个页面方案"]
         (for [[index plan] (map-indexed vector (:plans state))]
           [:div {:key (:id plan) :class (stl/css :plan-step)}
            [:> button* {:variant "secondary" :disabled (:busy state)
                         :aria-pressed (= (:id plan) (get-in state [:plan :id]))
                         :on-click #(swap! state* ai/select-plan (:id plan))}
             (str "方案 " (inc index) "：" (get-in plan [:generation :title]))]
            [:p {:class (stl/css :helper)} (get-in plan [:generation :goal])]
            [:p {:class (stl/css :helper)}
             (str/join " → " (map :name (get-in plan [:generation :sections])))]])])
      (when-let [plan (:plan state)]
        [:section {:class (stl/css :plan) :aria-label "待确认操作计划"}
         [:h3 {:class (stl/css :empty-title)} "操作预览"]
         [:p {:class (stl/css :helper)} "计划 5 分钟后过期。确认前请核对目标和属性。"]
         (when-let [generation (:generation plan)]
           [:div
            [:h4 {:class (stl/css :empty-title)} (:title generation)]
            [:p {:class (stl/css :helper)} (:goal generation)]
            [:p {:class (stl/css :helper)}
             (:width generation) " × " (:height generation) " · " (:style generation)
             " · " (count (:operations plan)) " 个操作 / " (ai/get-batch-count plan) " 批"]
            [:p {:class (stl/css :helper)} "角色：" (str/join "、" (:roles generation))]
            [:p {:class (stl/css :helper)} "交互规划（仅视觉元素）：" (str/join "、" (:interactions generation))]
            [:ul {:class (stl/css :plan-list)}
             (for [section (:sections generation)]
               [:li {:key (:key section) :class (stl/css :helper)}
                (when (:parent section) (str (:parent section) " → ")) (:name section) " · " (:type section)])]
            (for [[index warning] (map-indexed vector (:warnings generation))]
              [:p {:key index :class (stl/css :warning)} warning])
            (when (seq (:issues generation))
              [:div
               [:h4 {:class (stl/css :empty-title)} "规则检查（矩形边界）"]
               (for [[index issue] (map-indexed vector (:issues generation))]
                 [:p {:key index :class (stl/css :helper)} (:message issue)])])])
         (when (:outsideSelection plan)
           [:p {:class (stl/css :warning) :role "alert"} "包含当前选区以外的修改或新建对象。确认将授权执行下列全部操作。"])
         [:details {:open (nil? (:generation plan))}
          [:summary {:class (stl/css :helper)} "查看全部操作与属性"]
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
                (when (:parentRef operation)
                  [:span {:class (stl/css :helper)} "父区域：" (:parentRef operation)])
                [:p {:class (stl/css :helper)} "修改后：" (ai/get-operation-summary operation)]
                (when-let [image (:image operation)]
                  [:img {:class (stl/css :image-preview)
                         :src (ai/get-image-data-url image) :alt "确认后将插入或替换的图片"}])]))]]
         [:p {:class (stl/css :helper)} "每批最多 10 个操作。失败或取消后保留已完成修改和对象记录，可按批使用原生撤销恢复。"]
         [:div {:class (stl/css :actions)}
          [:> button* {:variant "secondary" :disabled (:busy state) :on-click #(decide "cancel")} "取消计划"]
          [:> button* {:variant "primary" :disabled (or (:busy state) (not connected))
                       :on-click #(decide "confirm")} (if (:busy state) "处理中…" "确认执行")]]])
      (when-let [result (:execution state)]
        [:section {:class (stl/css :plan) :aria-label "操作执行结果"}
         [:h3 {:class (stl/css :empty-title)}
          (get {"success" "已执行并验证" "partial" "部分完成，已停止" "failed" "执行失败"} (:status result))]
         (when (:cancelled result)
           [:p {:class (stl/css :helper) :role "status"} "已取消后续步骤，已生成的对象保留如下。"])
         (when (:message result)
           [:p {:class (stl/css :warning) :role "alert"} (:message result)])
         (when (seq (:batches result))
           [:p {:class (stl/css :helper)} "执行批数：" (count (:batches result)) "；每批结果与对象均已记录。"])
         (when (seq (:issues result))
           [:div
            [:h4 {:class (stl/css :empty-title)} "画布回读检查"]
            [:p {:class (stl/css :helper)} "以下为边界与重叠规则检查；有意叠放需人工判断，审美建议不属于确定性结果。"]
            (for [[index issue] (map-indexed vector (:issues result))]
              [:div {:key index :class (stl/css :plan-step)}
               [:p {:class (stl/css :helper)} (:message issue)]
               (for [id (:shapeIds issue)]
                 [:> button* {:key id :variant "ghost"
                              :on-click #(when (get @refs/workspace-page-objects (uuid/uuid id))
                                           (st/emit! (dws/select-shapes (d/ordered-set (uuid/uuid id)))
                                                     dw/zoom-to-selected-shape))} "定位相关图层"])])])
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
               "get_shape_tree" "查看图层结构"
               "get_design_system" "读取设计规范与组件"
               "propose_page_layout" "规划页面布局"
               "request_design_clarification" "整理待澄清问题"} name (str "规划：" (get ai/tool-labels name name)))
         " · " (case status "complete" "已完成" "retrying" "正在校正参数…" "处理中…")])
      (when (get-in state [:context :truncated]) [:p {:class (stl/css :helper)} "上下文已截断，回答仅基于已读取的图层。"])
      (when (:busy state)
        [:p {:class (stl/css :helper)}
         (if (:executing state) "正在分批执行并回读核验；取消将停止后续步骤，已完成的内容保留。" "正在生成规划或回答…")])]
     (when (:error state) [:p {:class (stl/css :error) :role "alert"} (:error state)])
     [:form {:class (stl/css :composer) :on-submit send}
      [:label {:for "ai-question" :class (stl/css :label)} "设计问题"]
      (when-let [image (:image state)]
        [:div {:class (stl/css :attachment)}
         [:img {:class (stl/css :attachment-preview) :src (ai/get-image-data-url image) :alt "待发送的参考图"}]
         [:span {:class (stl/css :helper)} "参考图 · " (:width image) " × " (:height image)]
         [:> icon-button* {:variant "ghost" :icon i/close :aria-label "移除参考图" :disabled (:busy state)
                           :on-click #(swap! state* assoc :image nil)}]])
      [:textarea {:id "ai-question" :class (stl/css :question) :value (:draft state) :max-length 4000 :rows 3
                  :disabled (:busy state)
                  :placeholder "描述设计需求，或直接粘贴参考图…"
                  :on-key-down #(when (ai/send-on-enter? %) (send %))
                  :on-paste #(when-let [file (ai/get-pasted-image (.-clipboardData %))]
                               (dom/prevent-default %)
                               (attach file))
                  :on-change #(swap! state* assoc :draft (dom/get-target-val %))}]
      [:input {:ref upload-ref :type "file" :hidden true :accept "image/png,image/jpeg,image/webp"
               :aria-label "选择参考图" :disabled (:busy state)
               :on-change #(when-let [file (aget (.-files (.-target %)) 0)]
                             (attach file)
                             (set! (.-value (.-target %)) ""))}]
      [:div {:class (stl/css :actions)}
       [:> button* {:variant "ghost" :disabled (or (:busy state) (:reading-image state))
                    :on-click #(some-> (mf/ref-val upload-ref) .click)}
        (if (:reading-image state) "读取图片…" "添加图片")]
       [:span {:class (stl/css :helper)} "Enter 发送 · Shift+Enter 换行"]]
      (when (:image state)
        [:p {:class (stl/css :helper)} "图片将随消息发送至当前模型；需选择支持图片的模型。"])
      (when-not connected
        [:p {:class (stl/css :helper)} "完成编辑器连接后即可发送。"])
      [:div {:class (stl/css :actions)}
       [:> button* {:variant "ghost" :disabled (:busy state)
                    :on-click #(do (reset! image-read* nil) (reset! state* ai/initial-state))} "新对话"]
       (if (:busy state)
         (if (:executing state)
           [:> button* {:variant "secondary" :disabled (:cancelling state) :on-click cancel-running}
            (if (:cancelling state) "正在取消…" "取消后续生成")]
           [:> button* {:variant "secondary" :on-click stop} "停止"])
         [:> button* {:type "submit" :variant "primary" :disabled (or (not connected) (empty? model) (some? (:plan state)) (seq (:plans state))
                                                                      (:reading-image state)
                                                                      (and (nil? (:image state)) (str/blank? (:draft state))))} "发送"])]]]))
