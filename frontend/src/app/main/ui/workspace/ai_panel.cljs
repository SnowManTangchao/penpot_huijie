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
                       (swap! state* assoc :busy false :answer "")))
        send        (mf/use-fn
                     (mf/deps file-id page-id selected session-id connected state model)
                     (fn [event]
                       (dom/prevent-default event)
                       (when (and connected (not (:busy state))
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
                                  :messages messages :tools {} :context nil)
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
      (when (:busy @state*)
        (stop)
        (swap! state* assoc :error "选区已改变，已停止回答。请根据当前选区重新提问。")))

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
       [:span {:class (stl/css :context-meta)} "只读 · 已选 " (count selected) " 个图层"]]
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
         [:h3 {:class (stl/css :empty-title)} "了解当前设计"]
         [:p {:class (stl/css :helper)} "选中图层，询问尺寸、文字、颜色或页面结构。回答会附上相关图层，方便定位。"]])
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
        [:p {:class (stl/css :answer)} (:answer state)])]
     [:div {:class (stl/css :status) :role "status" :aria-live "polite"}
      (for [[name status] (:tools state)]
        [:div {:key name}
         (get {"get_current_design_context" "读取设计上下文"
               "get_current_file_context" "查看当前文件"
               "get_current_page" "查看当前页面"
               "get_selected_shapes" "查看选中图层"
               "get_shape_tree" "查看图层结构"} name "读取设计信息")
         " · " (if (= status "complete") "已完成" "读取中…")])
      (when (get-in state [:context :truncated]) [:p {:class (stl/css :helper)} "上下文已截断，回答仅基于已读取的图层。"])
      (when (:busy state) [:p {:class (stl/css :helper)} "正在生成，完成后校验图层引用。"])]
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
       [:> button* {:variant "ghost" :disabled (:busy state)
                    :on-click #(reset! state* ai/initial-state)} "新对话"]
       (if (:busy state)
         [:> button* {:variant "secondary" :on-click stop} "停止"]
         [:> button* {:type "submit" :variant "primary" :disabled (or (not connected) (empty? model)
                                                                      (str/blank? (:draft state)))} "发送"])]]]))
