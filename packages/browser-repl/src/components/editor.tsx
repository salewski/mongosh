import React, { Component } from 'react';
import PropTypes from 'prop-types';
import AceEditor from 'react-ace';

import 'brace/mode/javascript';
import 'mongodb-ace-theme';

const noop = (): void => {
  //
};

interface EditorProps {
  onEnter?(): void | Promise<void>;
  onArrowUpOnFirstLine?(): void | Promise<void>;
  onArrowDownOnLastLine?(): void | Promise<void>;
  onChange?(value: string): void | Promise<void>;
  value?: string;
}

export class Editor extends Component<EditorProps> {
  static propTypes = {
    onEnter: PropTypes.func,
    onArrowUpOnFirstLine: PropTypes.func,
    onArrowDownOnLastLine: PropTypes.func,
    onChange: PropTypes.func,
    value: PropTypes.string
  };

  static defaultProps = {
    onEnter: noop,
    onArrowUpOnFirstLine: noop,
    onArrowDownOnLastLine: noop,
    onChange: noop,
    value: ''
  }

  private editor: any;

  private onEditorLoad = (editor: any): void => {
    this.editor = editor;
  }

  render(): JSX.Element {
    return (<AceEditor
      name={`mongosh-ace-${Date.now()}`}
      // mode="javascript"
      // theme="mongodb"
      onChange={this.props.onChange}
      onLoad={this.onEditorLoad}
      commands={[
        {
          name: 'return',
          bindKey: {win: 'Return', mac: 'Return'},
          exec: (): void => {
            this.props.onEnter();
          }
        },
        {
          name: 'arrowUpOnFirstLine',
          bindKey: {win: 'Up', mac: 'Up'},
          exec: (): void => {
            const selectionRange = this.editor.getSelectionRange();
            if (!selectionRange.isEmpty() || selectionRange.start.row !== 0) {
              return this.editor.selection.moveCursorUp();
            }

            this.props.onArrowUpOnFirstLine();
          }
        },
        {
          name: 'arrowDownOnLastLine',
          bindKey: {win: 'Down', mac: 'Down'},
          exec: (): void => {
            const selectionRange = this.editor.getSelectionRange();
            const lastRowIndex = this.editor.session.getLength() - 1;

            if (!selectionRange.isEmpty() || selectionRange.start.row !== lastRowIndex) {
              return this.editor.selection.moveCursorDown();
            }

            this.props.onArrowDownOnLastLine();
          }
        }
      ]}
      width="100%"
      maxLines={Infinity}
      value={this.props.value}
    />);
  }
}