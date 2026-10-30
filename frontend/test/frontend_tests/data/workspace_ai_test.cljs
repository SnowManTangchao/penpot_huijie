(ns frontend-tests.data.workspace-ai-test
  (:require
   [app.main.data.workspace.ai :as ai]
   [cljs.test :refer [deftest is]]))

(deftest handles-split-network-events
  (let [first-part (ai/parse-chunk "" "{\"type\":\"del")
        next-part  (ai/parse-chunk (:pending first-part) "ta\",\"text\":\"你好\"}\n{\"type\":\"done\"}\n")]
    (is (empty? (:events first-part)))
    (is (= [{:type "delta" :text "你好"} {:type "done"}] (:events next-part)))
    (is (= "" (:pending next-part)))))

(deftest rejects-provisional-answer-after-stream-error
  (let [state (-> (assoc ai/initial-state :busy true)
                  (ai/apply-event {:type "delta" :text "尚未校验的回答"})
                  (ai/apply-event {:type "error" :message "连接中断"}))]
    (is (= "" (:answer state)))
    (is (false? (:busy state)))
    (is (empty? (:messages state)))))

(deftest preserves-validated-citations-with-their-snapshot
  (let [context {:page {:id "page"} :shapes [{:id "shape" :name "画板"}]}
        state   (-> ai/initial-state
                    (ai/apply-event {:type "context" :context context})
                    (ai/apply-event {:type "done" :answer "画板" :citedShapeIds ["shape"]}))]
    (is (= context (get-in state [:messages 0 :context])))
    (is (= ["shape"] (get-in state [:messages 0 :citations])))))

(deftest explains-why-the-editor-cannot-connect
  (is (= :unavailable (:status (ai/get-connection-state false {}))))
  (is (= :settings (:action (ai/get-connection-state true {:enabled false}))))
  (is (= :settings (:action (ai/get-connection-state true {:enabled true :token-valid false}))))
  (is (= :connect (:action (ai/get-connection-state true {:enabled true :token-valid true :connection-status "disconnected"})))))

(deftest requires-an-authenticated-editor-session-before-sending
  (let [connecting {:enabled true :token-valid true :connection-status "connecting"}
        connected  {:enabled true :token-valid true :connection-status "connected"}]
    (is (= :connecting (:status (ai/get-connection-state true connecting))))
    (is (nil? (:action (ai/get-connection-state true connecting))))
    (is (not= :ready (:status (ai/get-connection-state true connected))))
    (is (= :ready (:status (ai/get-connection-state true (assoc connected :session-id "editor-tab")))))))
